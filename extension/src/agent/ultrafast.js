// HailBrowser Ultrafast: page -> indexed elements -> one decision (operation + target) -> execute.
// No screenshots, one decision request per step, a small text model only for TYPE_TEXT.
// Loop design adapted from browser-use/jev-ultrafast agent.py (MIT, (c) 2026 Browser Use).
import * as cdp from '../browser/cdp.js';
import * as inj from '../browser/inject.js';
import * as page from '../browser/page.js';
import { StaleError } from '../browser/page.js';
import { providerConfig } from '../settings.js';
import { buildActions, chooseValue, decide, fieldContext, fieldText } from './decision.js';

const OBSERVE = { viewportOnly: true, maxElements: 400, maxText: 6000 };

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
  if (action.kind === 'scroll') {
    await cdp.wheel(tabId, snap.viewport.w / 2, snap.viewport.h / 2, 0, action.delta);
    return page.sleep(60);
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
  let point;
  try {
    point = await page.pointFor(tabId, action.node);
  } catch (e) {
    throw new StaleError(e.message);
  }
  await cdp.mouseClick(tabId, point.x, point.y);
  if (action.kind === 'fill') {
    await page.run(tabId, inj.focusNode, action.node);
    await cdp.insertText(tabId, text, { replace: true });
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
    : uf.backend === 'choice' ? providerConfig(settings, uf.choiceProvider) : null;
  let textCfg = null;
  const history = [];
  let decisions = 0, stale = 0, pendingText = null, textCalls = 0;
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const finish = (status, reason, snap) => {
    const summary = `${status === 'done' ? '✅ Done' : status === 'stopped' ? '⏹ Stopped' : '⚠️ Blocked'}` +
      ` in ${(elapsed() / 1000).toFixed(1)}s · ${history.length} actions · ${decisions} decisions · ${textCalls} text calls` +
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

    const { actions } = buildActions(snap);
    const decision = await decide({ snap, actions, goal, history, settings, decisionCfg, signal });
    decisions++;
    const action = actions.find((a) => a.id === decision.choice);
    emit({
      type: 'decision', operation: decision.operation, target: decision.target, label: action?.label || decision.choice,
      confidence: decision.confidence, latencyMs: decision.latencyMs, reason: decision.reason, text: decision.text, elapsedMs: elapsed(),
    });

    if (decision.choice === 'DONE' || decision.choice === 'BLOCKED') {
      const now = await page.observe(tabId, OBSERVE);
      if (marker(now) !== marker(snap)) { snap = now; stale++; continue; } // decided on an old page
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
              if (!values) throw e;
              return finish('blocked', `None of the provided values fits "${action.label}" and no text helper is configured. Add it to values.`, snap);
            }
          }
          const helper = await fieldText(context, textCfg, uf.textModel, signal);
          textCalls++;
          text = helper.text;
          pendingText = { key, text };
          emit({ type: 'text', field: action.label, text, latencyMs: helper.latencyMs, model: helper.model });
        }
      }
    }

    if (signal.aborted) return finish('stopped', null, snap);
    try {
      await act(tabId, action, snap, text);
    } catch (e) {
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
    const next = await observeAfter(tabId, action);
    entry.page_changed = marker(next) !== marker(snap);
    snap = next;
    emit({ type: 'action', ...entry, elapsedMs: elapsed() });

    const last = history.slice(-3);
    if (last.length === 3 && last.every((h) => h.page_changed === false && h.kind !== 'wait')) {
      return finish('blocked', 'Three actions in a row changed nothing.', snap);
    }
  }
}
