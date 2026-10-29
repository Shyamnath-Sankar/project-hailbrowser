// HailBrowser Ultrafast: page -> indexed elements -> one decision (operation + target) -> execute.
// No screenshots, one decision request per step, a small text model only for TYPE_TEXT.
// Loop design adapted from browser-use/jev-ultrafast agent.py (MIT, (c) 2026 Browser Use).
import * as cdp from '../browser/cdp.js';
import * as inj from '../browser/inject.js';
import * as page from '../browser/page.js';
import { StaleError } from '../browser/page.js';
import { providerConfig, SCORE_BACKENDS } from '../settings.js';
import { buildActions, chooseValue, decide, decideWithChatModel, fieldContext, fieldText, makeChecklist, pageNotes, verifyDone } from './decision.js';
import { onSite, sitesFromGoal } from './sites.js';

const OBSERVE = { viewportOnly: true, maxElements: 400, maxText: 6000 };
const LOW_CONFIDENCE = 0.55; // below this the chat model takes the step
const MAX_ESCALATIONS = 6;

export function marker(snap) {
  return JSON.stringify([snap.url, snap.scroll.y, snap.viewport.w, snap.viewport.h, snap.title, snap.text,
    snap.elements.map((e) => [e.id, e.label, e.value, e.checked, e.selected, e.expanded]), snap.formKey]);
}

function elementKey(snap, node) {
  const e = snap.elements.find((x) => x.id === node);
  return e ? JSON.stringify([e.role, e.label, e.value, e.checked, e.selected, e.expanded, e.options?.length]) : null;
}

async function observeAfter(tabId, action) {
  if (action && action.kind !== 'wait' && action.kind !== 'scroll') {
    const autocomplete = action.kind === 'fill' && action.role === 'combobox';
    await page.run(tabId, inj.waitSettled, autocomplete).catch(() => {});
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'loading') await page.waitForLoad(tabId, 15000);
  }
  return page.observe(tabId, OBSERVE);
}

/** Execute one observed action. Throws StaleError (nothing executed) if the target changed. */
async function act(tabId, action, snap, text) {
  if (action.kind === 'wait') return page.sleep(100);
  // Navigation targets come from the user's goal (see sites.js), never from the model.
  if (action.kind === 'open') return page.navigate(tabId, action.url);
  if (action.kind === 'back') return page.navigate(tabId, 'back');
  if (action.kind === 'key') return cdp.pressChord(tabId, action.key);
  if (action.kind === 'scroll') {
    // Scroll the page, or an observed inner panel, directly: exact, and no late wheel animation to race.
    const probe = await page.run(tabId, inj.scrollProbe, action.node ?? null, null, null, 0, action.delta);
    if (!probe || probe.error) return;
    const after = await page.run(tabId, inj.scrollCheck, probe, 0, action.delta, 'direct');
    if (after && !after.moved) {
      await cdp.wheel(tabId, probe.x, probe.y, 0, action.delta);
      await page.run(tabId, inj.scrollCheck, probe, 0, action.delta, 'wheel');
    }
    return;
  }
  // Scoped freshness guard: same document URL, same form values, same target semantics.
  const now = await page.observe(tabId, OBSERVE);
  if (now.url !== snap.url || now.formKey !== snap.formKey || elementKey(now, action.node) !== elementKey(snap, action.node)) {
    throw new StaleError('Page changed since the decision');
  }
  if (action.kind === 'select') {
    const res = await page.run(tabId, inj.selectOptionNode, action.node, action.value);
    if (res?.error) throw new StaleError(res.error);
    return;
  }
  if (action.kind === 'enter') {
    await page.run(tabId, inj.focusNode, action.node);
    return cdp.pressChord(tabId, 'Enter');
  }
  let point;
  try {
    point = await page.pointFor(tabId, action.node);
  } catch (e) {
    throw new StaleError(e.message);
  }
  if (action.kind === 'hover') {
    await cdp.mouseMove(tabId, point.x, point.y);
    return page.sleep(250); // let the submenu open
  }
  await cdp.mouseClick(tabId, point.x, point.y);
  if (action.kind === 'fill') {
    const info = await page.run(tabId, inj.focusNode, action.node);
    if (info?.special) await page.run(tabId, inj.setNativeValue, action.node, text);
    else await cdp.insertText(tabId, text, { replace: true });
  }
}

/**
 * Run a goal. emit(event) receives progress events for the side panel.
 * Returns {status: 'done'|'blocked'|'stopped'|'error', summary, history, elapsedMs}.
 */
export async function runUltrafast({ goal: task, values = null, tabId, settings, signal, emit }) {
  const uf = settings.ultrafast;
  // Caller-provided values (e.g. from OpenCode/Claude Code) are part of the goal for every decision.
  const goal = values ? `${task}\n\nValues to use: ${JSON.stringify(values)}` : task;
  const decisionCfg = uf.backend === 'llm' ? providerConfig(settings, uf.decisionProvider)
    : uf.backend === 'choice' ? providerConfig(settings, uf.choiceProvider)
      : uf.backend === 'openrouter' || uf.backend === 'inception' ? providerConfig(settings, uf.backend) : null;
  let textCfg = null, textModel = uf.textModel;
  // The user's chat model, when configured: writes a goal checklist (in parallel with the first
  // decisions, so it adds no wait) and takes over single hard steps (escalation).
  let chatCfg = null;
  try { chatCfg = uf.useChatModel === false ? null : providerConfig(settings, settings.normal.provider); } catch { /* no chat model set up */ }
  const chatModel = settings.normal.model;
  const canEscalate = !!chatCfg && uf.backend !== 'llm';
  let escalations = 0, escalateNext = false, requirements = [];
  const checklist = chatCfg
    ? makeChecklist({ goal, cfg: chatCfg, model: chatModel, signal }).then((r) => {
      requirements = r;
      if (r.length) emit({ type: 'checklist', items: r });
      return r;
    })
    : Promise.resolve([]);
  // The checklist shows progress and names what is missing when DONE is rejected. It is not fed
  // into decisions: model-written requirements can go beyond the goal and cause extra actions.
  checklist.catch(() => {});
  const history = [];
  // Sites the goal names; offered as Open controls when the page is elsewhere.
  const sites = sitesFromGoal(task);
  // Rejected DONE claims, shown to the model as recent actions until the page changes.
  const checks = [];
  let nudgedSubmit = false, rejectedDone = 0;
  let decisions = 0, stale = 0, pendingText = null, textCalls = 0;
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const finish = (status, reason, snap) => {
    const summary = `${status === 'done' ? '✅ Done' : status === 'stopped' ? '⏹ Stopped' : '⚠️ Blocked'}` +
      ` in ${(elapsed() / 1000).toFixed(1)}s · ${history.length} actions · ${decisions} decisions · ${textCalls} text calls` +
      (escalations ? ` · ${escalations} chat-model step${escalations > 1 ? 's' : ''}` : '') +
      (reason ? `\n${reason}` : '') + (snap ? `\nFinal page: ${snap.title} — ${snap.url}` : '');
    emit({ type: 'finish', status, summary });
    return { status, summary, history, elapsedMs: elapsed(), finalUrl: snap?.url, finalTitle: snap?.title };
  };

  let snap = await page.observe(tabId, OBSERVE);
  emit({ type: 'status', text: `Observed ${snap.elements.length} elements on ${snap.title || snap.url}` });

  for (;;) {
    if (signal.aborted) return finish('stopped', null, snap);
    if (history.length >= uf.maxActions) return finish('blocked', `Stopped at the ${uf.maxActions}-action budget.`, snap);
    if (decisions >= uf.maxActions * 2) return finish('blocked', 'Reached the decision budget.', snap);
    if (stale > 6) return finish('blocked', 'The page kept changing under every decision.', snap);

    const { actions, omitted } = buildActions(snap, {
      sites: sites.filter((s) => !onSite(snap.url, s.url)),
      canGoBack: history.some((h) => h.page_changed),
    });
    // Page facts the element table can't show (overlays, content below the fold, inner panels),
    // and a note when the candidate list was cut, so the model scrolls instead of giving up.
    const notes = [omitted ? `[${omitted} more on-screen actions were not listed. Scroll to bring other parts of the page into view.]` : '', pageNotes(snap)].filter(Boolean).join('\n');
    const view = notes ? { ...snap, text: `${notes}\n${snap.text}` } : snap;
    const decisionGoal = goal;
    const seen = [...history, ...checks];
    let decision = await decide({ snap: view, actions, goal: decisionGoal, history: seen, settings, decisionCfg, signal });
    decisions++;
    // Escalate one step to the chat model when the fast model is unsure, about to give up, or stuck.
    const stuck = history.length >= 2 && history.slice(-2).every((h) => h.page_changed === false && h.kind !== 'wait');
    const why = decision.choice === 'BLOCKED' ? 'it was about to give up'
      : decision.confidence != null && decision.confidence < LOW_CONFIDENCE ? 'it was unsure'
        : stuck ? 'the last steps changed nothing' : escalateNext ? 'the last step needed help' : null;
    if (canEscalate && why && escalations < MAX_ESCALATIONS) {
      escalateNext = false;
      try {
        decision = await decideWithChatModel({ snap: view, actions, goal: decisionGoal, history: seen, cfg: chatCfg, model: chatModel, signal });
        escalations++;
        decisions++;
        emit({ type: 'status', text: `Asked ${chatModel} for this step (${why}).` });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        emit({ type: 'status', text: `The chat model could not help with this step: ${e.message.slice(0, 120)}` });
      }
    }
    const action = actions.find((a) => a.id === decision.choice);
    emit({
      type: 'decision', operation: decision.operation, target: decision.target, label: action?.label || decision.choice,
      confidence: decision.confidence, latencyMs: decision.latencyMs, reason: decision.reason, text: decision.text, elapsedMs: elapsed(),
      escalated: !!decision.escalated, model: decision.escalated ? chatModel : undefined,
    });

    if (decision.choice === 'DONE' || decision.choice === 'BLOCKED') {
      const now = await page.observe(tabId, OBSERVE);
      if (marker(now) !== marker(snap)) { snap = now; stale++; continue; } // decided on an old page
      if (decision.choice === 'DONE' && !nudgedSubmit) {
        // Typed text that was never submitted is the most common false finish: send it back once.
        const lastFill = history.map((h) => h.kind).lastIndexOf('fill');
        if (lastFill >= 0 && !history.slice(lastFill + 1).some((h) => ['click', 'enter', 'key', 'open', 'back'].includes(h.kind))) {
          nudgedSubmit = true;
          emit({ type: 'status', text: `Not finished yet: "${history[lastFill].action}" was typed but never submitted.` });
          checks.push({ action: `DONE was rejected: the text typed into "${history[lastFill].action}" was never submitted. CLICK its Search/Submit button or PRESS_ENTER in it.`, kind: 'check', text: null, page_changed: false });
          continue;
        }
      }
      if (decision.choice === 'DONE') {
        // DONE is a claim: ask once more whether every part of the goal is visibly met.
        // With a checklist, each requirement is checked on its own and the misses are named.
        await checklist.catch(() => []);
        const check = await verifyDone({ snap: view, goal, history: [...history, ...checks], settings, decisionCfg, signal, requirements });
        decisions++;
        if (requirements.length && (check.met || check.done)) emit({ type: 'checklist', items: requirements, met: check.met || requirements.map(() => true) });
        if (!check.done) {
          const missing = check.unmet?.length ? check.unmet.join('; ') : 'part of the goal';
          emit({ type: 'status', text: `Not finished yet: ${missing}.` });
          if (++rejectedDone >= 2) return finish('blocked', `The model said DONE twice, but this is still not met: ${missing}.`, snap);
          checks.push({ action: `DONE was rejected. Still not met: ${missing}. Choose the operation that completes it.`, kind: 'check', text: null, page_changed: false });
          escalateNext = true;
          continue;
        }
      }
      return finish(decision.choice === 'DONE' ? 'done' : 'blocked', decision.reason, snap);
    }

    let text = null;
    if (action.kind === 'fill') {
      const chosen = decision.text ? null
        : await chooseValue({ goal, action, snap, values, settings, decisionCfg, signal });
      if (decision.text) {
        text = decision.text;
      } else if (chosen) {
        text = chosen.text;
        emit({ type: 'text', field: action.label, text, latencyMs: chosen.latencyMs, model: `value "${chosen.key}" (${chosen.via})` });
      } else {
        const context = fieldContext(goal, action, snap, history);
        const key = JSON.stringify(context);
        // Reuse a generated value across a stale retry only if the helper input is identical.
        if (pendingText?.key === key) {
          text = pendingText.text;
        } else {
          if (!textCfg) {
            try {
              textCfg = providerConfig(settings, uf.textProvider);
            } catch (e) {
              // Inception-only setup: its own chat model can write the text too.
              if (uf.backend === 'inception') {
                try { textCfg = providerConfig(settings, 'inception'); textModel = 'mercury-2'; } catch { /* fall through */ }
              }
              if (!textCfg) {
                if (!values) throw e;
                return finish('blocked', `None of the provided values fits "${action.label}" and no text helper is configured. Add it to values.`, snap);
              }
            }
          }
          let helper;
          try {
            helper = await fieldText(context, textCfg, textModel, signal);
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            textCalls++;
            // The helper could not work out the value: let the chat model take this step (it writes the
            // text itself), or stop with the reason instead of failing the whole run.
            if (!canEscalate || escalations >= MAX_ESCALATIONS) return finish('blocked', `Could not work out what to type into "${action.label}": ${e.message}`, snap);
            emit({ type: 'status', text: `The text helper had no value for "${action.label}"; handing this step to the chat model.` });
            checks.push({ action: `Could not work out what to type into "${action.label}". Decide again; for TYPE_TEXT include the exact text.`, kind: 'check', text: null, page_changed: false });
            escalateNext = true;
            continue;
          }
          textCalls++;
          text = helper.text;
          pendingText = { key, text };
          emit({ type: 'text', field: action.label, text, latencyMs: helper.latencyMs, model: helper.model });
        }
      }
    }

    if (signal.aborted) return finish('stopped', null, snap);
    // A link or button may open a new tab: the run follows it there.
    const newTabs = page.watchNewTabs(tabId);
    try {
      await act(tabId, action, snap, text);
    } catch (e) {
      await newTabs.stop();
      if (e instanceof cdp.DialogError) return finish('blocked', e.message, snap);
      if (!(e instanceof StaleError)) throw e;
      stale++;
      emit({ type: 'stale', text: e.message });
      snap = await page.observe(tabId, OBSERVE);
      continue;
    }
    stale = 0;
    pendingText = null;
    // Log execution before observing: a failed observation must not erase the action.
    const entry = { step: history.length + 1, action: action.label, kind: action.kind, operation: decision.operation, text, page_changed: null, url: snap.url };
    history.push(entry);
    let next;
    try {
      next = await observeAfter(tabId, action);
    } catch (e) {
      await newTabs.stop();
      if (e instanceof cdp.DialogError) return finish('blocked', `After "${action.label}": ${e.message}`, snap);
      throw e;
    }
    const opened = (await newTabs.stop(action.newTab ? 400 : 0)).filter((t) => !page.isRestricted(t.pendingUrl || t.url || ''));
    if (opened.length) {
      tabId = opened[opened.length - 1].id;
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      page.setCurrentTab(tabId);
      await page.waitForLoad(tabId, 15000).catch(() => {});
      next = await page.observe(tabId, OBSERVE);
      emit({ type: 'status', text: `Followed the new tab: ${next.title || next.url}` });
    }
    entry.page_changed = opened.length > 0 || marker(next) !== marker(snap);
    if (entry.page_changed) { checks.length = 0; rejectedDone = 0; }
    snap = next;
    emit({ type: 'action', ...entry, elapsedMs: elapsed() });

    const last = history.slice(-3);
    if (last.length === 3 && last.every((h) => h.page_changed === false && h.kind !== 'wait')) {
      return finish('blocked', 'Three actions in a row changed nothing.', snap);
    }
  }
}
