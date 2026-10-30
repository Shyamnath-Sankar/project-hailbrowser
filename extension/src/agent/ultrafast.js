// HailBrowser Ultrafast: page -> indexed elements -> one decision (operation + target) -> execute.
// No screenshots, one decision request per step, a small text model only for TYPE_TEXT.
// Loop design adapted from browser-use/jev-ultrafast agent.py (MIT, (c) 2026 Browser Use).
import * as cdp from '../browser/cdp.js';
import * as inj from '../browser/inject.js';
import * as page from '../browser/page.js';
import { StaleError } from '../browser/page.js';
import { providerConfig, SCORE_BACKENDS } from '../settings.js';
import { answerQuestion, buildActions, chooseValue, decide, decideWithChatModel, fieldContext, fieldText, makeChecklist, pageNotes, verifyDone } from './decision.js';
import { onSite, sitesFromGoal } from './sites.js';

const OBSERVE = { viewportOnly: true, maxElements: 400, maxText: 6000 };
const FRESHNESS = { ...OBSERVE, light: true }; // same elements and form values, no context/text extras
const LOW_CONFIDENCE = 0.55; // below this the chat model takes the step
const MAX_ESCALATIONS = 6;
// Goals limited to the current page never fall back to a web search.
const LOCAL_SCOPE = /\b(this|current|the same) (page|site|tab|article)\b|\bon here\b|\bhere on\b/i;
const ANSWER_TEXT = 12000; // characters of the final page given to the answer step
// Goals that ask for information back, when no chat model is there to say so.
// A false positive only costs one answer read: an answer that isn't found never causes extra actions.
const QUESTION = /\?|^(what|which|who|whom|whose|when|where|why|how|is|are|does|do|did|can|list)\b|\b(tell me|find out|let me know|report back|in which|what (is|are|was|were)|how (many|much|long|old))\b/i;

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
  const now = await page.observe(tabId, FRESHNESS);
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
export async function runUltrafast({ goal: task, values = null, tabId, settings, signal, emit, lane = 'agent' }) {
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
  let escalations = 0, escalateNext = false, requirements = [], wantsAnswer = QUESTION.test(task.trim());
  const checklist = chatCfg
    ? makeChecklist({ goal, cfg: chatCfg, model: chatModel, signal }).then((r) => {
      requirements = r.requirements;
      wantsAnswer ||= r.wantsAnswer;
      if (requirements.length) emit({ type: 'checklist', items: requirements });
      return requirements;
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
  // Questions ("what does X cost?", "which is cheapest?") end with an answer read from the final page.
  const answerFor = async () => {
    await checklist.catch(() => []);
    if (!wantsAnswer) return null;
    let cfg = chatCfg, model = chatModel;
    if (!cfg) {
      try { cfg = providerConfig(settings, uf.textProvider); model = uf.textModel; } catch {
        try { if (uf.backend === 'inception') { cfg = providerConfig(settings, 'inception'); model = 'mercury-2'; } } catch { /* none */ }
      }
    }
    if (!cfg) return null;
    let pageNow;
    try { pageNow = await page.run(tabId, inj.pageText, ANSWER_TEXT); } catch { return null; }
    // Reading only (no browser action), so one retry on a malformed reply is safe.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await answerQuestion({ goal, page: pageNow, cfg, model, signal });
        if (out) { emit({ type: 'status', text: `Read the answer from the page (${out.latencyMs} ms).` }); return out; }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }
    return null;
  };
  const finish = async (status, reason, snap, known) => {
    // A stuck question still gets an answer: often "the page doesn't say", which is the honest result.
    const answer = known !== undefined ? known : status !== 'stopped' ? await answerFor() : null;
    const summary = `${status === 'done' ? '✅ Done' : status === 'stopped' ? '⏹ Stopped' : '⚠️ Blocked'}` +
      ` in ${(elapsed() / 1000).toFixed(1)}s · ${history.length} actions · ${decisions} decisions · ${textCalls} text calls` +
      (escalations ? ` · ${escalations} chat-model step${escalations > 1 ? 's' : ''}` : '') +
      (reason ? `\n${reason}` : '') + (snap ? `\nFinal page: ${snap.title} — ${snap.url}` : '') +
      (answer ? `\n\nAnswer:\n${answer.answer}` : '');
    emit({ type: 'finish', status, summary, answer: answer?.answer || null, answerFound: answer?.found ?? null });
    return { status, summary, history, elapsedMs: elapsed(), finalUrl: snap?.url, finalTitle: snap?.title, answer: answer?.answer || null };
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
        await checklist.catch(() => []);
        if (wantsAnswer) {
          // For a question, reading the answer is the check: no answer on this page means keep going (once).
          const ans = await answerFor();
          decisions++;
          // Go on looking only if the goal itself is also unfinished: a finished action whose page just
          // doesn't spell out the answer must not trigger more clicks (that can resubmit forms).
          const unfinished = ans && !ans.found && rejectedDone < 1 &&
            !(await verifyDone({ snap: view, goal, history: [...history, ...checks], settings, decisionCfg, signal }).catch(() => ({ done: false }))).done;
          if (unfinished) {
            rejectedDone++;
            emit({ type: 'status', text: 'The answer is not on this page yet; looking further.' });
            checks.push({ action: 'DONE was rejected: the information the goal asks for is not on this page yet. Search, open or scroll to where it is.', kind: 'check', text: null, page_changed: false });
            escalateNext = true;
            continue;
          }
          return finish(ans && !ans.found && rejectedDone ? 'blocked' : 'done', ans && !ans.found ? 'The page does not show what was asked.' : decision.reason, snap, ans);
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
      if (decision.choice === 'BLOCKED' && !sites.length && !LOCAL_SCOPE.test(task) && !history.some((h) => h.kind === 'search')) {
        // Nothing here for the goal and no site named: search the web for it (the query is the user's
        // own goal text, never page text) and carry on from the results, instead of giving up.
        emit({ type: 'status', text: 'Nothing for this on the current page: searching the web for your goal.' });
        await page.searchFromBlocked(tabId, task.slice(0, 300), `https://duckduckgo.com/?q=${encodeURIComponent(task.slice(0, 300))}`);
        const entry = { step: history.length + 1, action: 'Search the web for the goal', kind: 'search', operation: 'SEARCH_WEB', text: null, page_changed: true, url: snap.url };
        history.push(entry);
        emit({ type: 'action', ...entry, elapsedMs: elapsed() });
        checks.length = 0;
        snap = await page.observe(tabId, OBSERVE);
        continue;
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
      page.setCurrentTab(tabId, { lane });
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
