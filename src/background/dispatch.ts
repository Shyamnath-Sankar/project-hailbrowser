import type {
  ActionResult,
  AgentAction,
  AskHuman,
  IndexedElement,
  MediaOp,
  PageSnapshot,
  Policy,
  Task,
} from "../shared/types";
import * as cdp from "./cdp/actions";
import { sendToFrame } from "./perception";
import { recall, remember, setNodeStatus } from "./memory/store";
import { getSkill, safeHost } from "./skills/router";
import { approvalKey } from "../shared/approvals";

/**
 * Runs the actions an executor turn asked for. Control-flow actions (done,
 * ask_human) and the ones that change context (load_skill, update_plan) come
 * back as signals so the orchestrator can act on them.
 */

export interface DispatchContext {
  task: Task;
  tabId: number;
  snapshot: PageSnapshot;
  policy: Policy;
  /** Course scope key, so remembered instructions land in the right scope. */
  courseKey: string;
}

export interface DispatchSignal {
  done?: { summary: string; success: boolean };
  ask?: Omit<AskHuman, "id" | "askedAt">;
  loadSkill?: string;
  /** Data the orchestrator folds into the scratchpad for the next prompt. */
  notes: string[];
  /** True when the page probably changed, so the next step must re-snapshot. */
  pageChanged: boolean;
  /** Approval keys used up by this turn, so a "once" grant is not reused. */
  consumedApprovals: string[];
  /** Set when the task should continue in a different tab. */
  switchTab?: number;
}

export interface DispatchOutcome {
  results: ActionResult[];
  signal: DispatchSignal;
}

type Gate = "allowed" | "denied" | "ask";

/**
 * Decides whether a gated action may proceed, given what the human already said.
 *
 * This is the fix for the confirm loop: the gate used to consult only the policy
 * and the label, so answering "yes" changed nothing and the next step asked the
 * identical question again, indefinitely.
 */
function checkApproval(
  ctx: DispatchContext,
  signal: DispatchSignal,
  kind: string,
  label: string,
): Gate {
  const key = approvalKey(kind, label, ctx.snapshot.url);
  const grant = ctx.task.approvals?.[key];
  if (!grant) return "ask";

  if (grant.mode === "denied") {
    // The note explains *why* to stop trying, which a bare failure line does not.
    if (grant.note) signal.notes.push(grant.note);
    return "denied";
  }
  if (grant.mode === "always") return "allowed";

  // A one-shot grant is spent here, so the next identical action asks again.
  signal.consumedApprovals.push(key);
  return "allowed";
}

/** Labels that mean an action is hard to undo. Used as a safety net. */
const RISKY = /\b(submit|buy|purchase|pay|checkout|order|place bid|delete|remove|cancel subscription|send|post|publish|confirm|apply now|withdraw|transfer)\b/i;

const ok = (detail: string, data?: string): ActionResult => ({ ok: true, detail, data });
const fail = (detail: string): ActionResult => ({ ok: false, detail });

/** Frame holding the player: recorded at snapshot time, main frame otherwise. */
function mediaFrame(ctx: DispatchContext): number {
  if (ctx.snapshot.mediaFrameId !== undefined) return ctx.snapshot.mediaFrameId;
  return ctx.snapshot.elements.find((e) => e.tag === "video" || e.tag === "audio")?.frameId ?? 0;
}

interface MediaOutcome {
  /** The frame answered at all. */
  reached: boolean;
  /** The player did what was asked (a clamped rate still counts as reached). */
  applied: boolean;
  detail: string;
}

/**
 * Sends a media op to the frame that owns the player, falling back to the main
 * frame. Returns what the player actually did, because players routinely clamp a
 * rate or re-apply their own mute.
 */
async function media(
  ctx: DispatchContext,
  op: MediaOp,
  rate?: number,
): Promise<MediaOutcome> {
  const frames = [mediaFrame(ctx), 0].filter((f, i, all) => all.indexOf(f) === i);
  let lastError = "no frame responded";

  for (const frameId of frames) {
    const reply = await sendToFrame(ctx.tabId, frameId, { type: "media", op, rate });
    if (reply.ok && reply.kind === "media") {
      return { reached: true, applied: reply.applied, detail: reply.detail };
    }
    if (!reply.ok) lastError = reply.error;
  }
  return { reached: false, applied: false, detail: lastError };
}

/**
 * Starts a lesson video according to the user's policy.
 *
 * When the policy is to skip, the jump is tried first and falls back to real
 * playback on its own if the player refuses. A course that merely *looks*
 * finished is the worst outcome here, so a blocked skip must never read as
 * success.
 */
async function startVideo(ctx: DispatchContext): Promise<ActionResult> {
  if (ctx.policy.videoStrategy !== "skip") return watchVideo(ctx);

  const skipped = await media(ctx, "seek_end");
  if (!skipped.reached) return fail(skipped.detail);
  if (skipped.applied) return ok(skipped.detail);

  // Locked seeking, unknown duration, or the player pulled the position back.
  // Watching is the only way this lesson gets credited.
  const watched = await watchVideo(ctx);
  return watched.ok
    ? ok(`Skipping did not work (${skipped.detail}). Watching it instead: ${watched.detail}`)
    : fail(`Could not skip (${skipped.detail}) and could not start playback either (${watched.detail})`);
}

/** Plays a video through, applying the rate and caption policy. */
async function watchVideo(ctx: DispatchContext): Promise<ActionResult> {
  const played = await media(ctx, "play");
  if (!played.reached || !played.applied) return fail(played.detail);

  const extra: string[] = [];
  if (ctx.policy.videoRate !== 1) {
    const rate = await media(ctx, "rate", ctx.policy.videoRate);
    if (rate.reached) extra.push(rate.detail);
  }
  if (ctx.policy.videoCaptions) {
    const captions = await media(ctx, "captions");
    // No caption track is normal, not a failure worth reporting.
    if (captions.reached && captions.applied) extra.push(captions.detail);
  }
  return ok([played.detail, ...extra].join("; "));
}

export async function dispatch(
  actions: AgentAction[],
  ctx: DispatchContext,
): Promise<DispatchOutcome> {
  const results: ActionResult[] = [];
  const signal: DispatchSignal = { notes: [], pageChanged: false, consumedApprovals: [] };

  const byIndex = new Map<number, IndexedElement>();
  for (const el of ctx.snapshot.elements) byIndex.set(el.index, el);

  for (const action of actions) {
    const result = await runOne(action, ctx, byIndex, signal);
    results.push(result);

    // Stop the batch on a control signal or a failure: everything after it was
    // planned against a page state that no longer holds.
    if (signal.done || signal.ask || signal.loadSkill) break;
    if (!result.ok) break;
  }

  return { results, signal };
}

async function runOne(
  action: AgentAction,
  ctx: DispatchContext,
  byIndex: Map<number, IndexedElement>,
  signal: DispatchSignal,
): Promise<ActionResult> {
  const { tabId } = ctx;

  const element = (index: number): IndexedElement | undefined => byIndex.get(index);

  try {
    switch (action.type) {
      case "navigate": {
        if (action.newTab) {
          const tab = await chrome.tabs.create({ url: action.url, active: true });
          if (tab.id === undefined) return fail("the browser did not return a new tab id");
          await waitForLoad(tab.id);
          // Hand the task over to the new tab. Without this the agent keeps
          // clicking in the old one while reading snapshots of it, which looks
          // like the page ignoring every action.
          signal.switchTab = tab.id;
          signal.pageChanged = true;
          signal.notes.push(`Opened a new tab at ${action.url} and switched to it.`);
          return ok(`opened new tab at ${action.url} and made it the working tab`);
        }
        await chrome.tabs.update(tabId, { url: action.url });
        await waitForLoad(tabId);
        signal.pageChanged = true;
        return ok(`navigated to ${action.url}`);
      }

      case "go_back": {
        await chrome.tabs.goBack(tabId);
        await waitForLoad(tabId);
        signal.pageChanged = true;
        return ok("went back");
      }

      case "click": {
        const el = element(action.index);
        if (!el) return fail(`index ${action.index} is not in the current snapshot`);
        if (el.disabled) return fail(`[${action.index}] ${el.label} is disabled`);

        // Safety net: the model is instructed to ask before irreversible acts,
        // but a policy that says confirm is enforced here regardless.
        if (ctx.policy.confirmBeforeSubmit && RISKY.test(el.label)) {
          const gate = checkApproval(ctx, signal, "click", el.label);
          if (gate === "denied") {
            return ok(`skipped clicking "${el.label}" - you declined it earlier`);
          }
          if (gate === "ask") {
            signal.ask = {
              kind: "confirm",
              question: `About to click "${el.label}" on ${ctx.snapshot.url}. This looks irreversible. Proceed?`,
              options: ["Yes, click it", "Yes, and stop asking", "No, skip it"],
              approvalKey: approvalKey("click", el.label, ctx.snapshot.url),
            };
            return ok(`paused for confirmation before clicking "${el.label}"`);
          }
        }

        const before = ctx.snapshot.url;
        await cdp.clickElement(tabId, el);
        await cdp.pause(400);
        const after = (await chrome.tabs.get(tabId).catch(() => undefined))?.url ?? before;
        if (after !== before) signal.pageChanged = true;
        return ok(`clicked [${action.index}] ${el.label}${after !== before ? ` (url is now ${after})` : ""}`);
      }

      case "hover": {
        const el = element(action.index);
        if (!el) return fail(`index ${action.index} is not in the current snapshot`);
        await cdp.hoverElement(tabId, el);
        return ok(`hovered [${action.index}] ${el.label}`);
      }

      case "type": {
        const el = element(action.index);
        if (!el) return fail(`index ${action.index} is not in the current snapshot`);

        // Enter in a composer sends the message, which is the same irreversible
        // act as clicking Send - and it used to bypass this gate entirely.
        if (action.submit && ctx.policy.confirmBeforeSubmit) {
          const label = el.label || "this field";
          const gate = checkApproval(ctx, signal, "submit", label);
          if (gate === "denied") {
            await cdp.typeText(tabId, el, action.text, action.clear !== false);
            return ok(`typed the text but did not press Enter - you declined sending from "${label}"`);
          }
          if (gate === "ask") {
            signal.ask = {
              kind: "confirm",
              question: `About to press Enter in "${label}" on ${ctx.snapshot.url}, which will send it. Proceed?`,
              options: ["Yes, send it", "Yes, and stop asking", "No, do not send"],
              approvalKey: approvalKey("submit", label, ctx.snapshot.url),
            };
            return ok(`paused for confirmation before sending from "${label}"`);
          }
        }

        await cdp.typeText(tabId, el, action.text, action.clear !== false);
        if (action.submit) {
          await cdp.pressKey(tabId, "Enter");
          await cdp.pause(500);
          signal.pageChanged = true;
        }
        return ok(`typed into [${action.index}] ${el.label}${action.submit ? " and pressed Enter" : ""}`);
      }

      case "select_option": {
        const el = element(action.index);
        if (!el) return fail(`index ${action.index} is not in the current snapshot`);
        const reply = await sendToFrame(tabId, el.frameId, {
          type: "set_value",
          index: el.index,
          value: action.value,
          kind: "select",
        });
        return reply.ok
          ? ok(`selected "${action.value}" in [${action.index}]`)
          : fail(reply.error);
      }

      case "check": {
        const el = element(action.index);
        if (!el) return fail(`index ${action.index} is not in the current snapshot`);
        // A real click is more reliable than setting .checked, because sites
        // bind their handlers to the click.
        if (el.checked !== action.checked) {
          await cdp.clickElement(tabId, el);
          await cdp.pause(200);
          return ok(`clicked [${action.index}] to set checked=${action.checked}`);
        }
        return ok(`[${action.index}] was already checked=${action.checked}`);
      }

      case "press_key": {
        await cdp.pressKey(tabId, action.key);
        await cdp.pause(200);
        if (action.key === "Enter") signal.pageChanged = true;
        return ok(`pressed ${action.key}`);
      }

      case "scroll": {
        await cdp.scrollBy(tabId, action.direction, action.amount);
        await cdp.pause(300);
        return ok(`scrolled ${action.direction}`);
      }

      case "media": {
        // "play" carries the user's video policy, so the model does not have to
        // remember it on every lesson.
        if (action.op === "play") return startVideo(ctx);
        const outcome = await media(ctx, action.op, action.rate);
        return outcome.reached && outcome.applied ? ok(outcome.detail) : fail(outcome.detail);
      }

      case "wait_until": {
        // Waits run in whichever frame owns the media, so a video inside an
        // iframe still resolves.
        const frameId =
          action.condition.type === "video_ended" ? mediaFrame(ctx) : 0;

        let condition = action.condition;
        let timeoutMs = action.timeoutMs;

        if (condition.type === "video_ended") {
          const state = ctx.snapshot.media;
          if (state && state.duration > 0) {
            // Models guess this badly, and a short timeout on a long video means
            // a wasted step plus a re-wait. The player knows how much is left.
            const remainingMs = ((state.duration - state.currentTime) / Math.max(state.rate, 0.25)) * 1000;
            const needed = Math.ceil(remainingMs * 1.15) + 10_000;
            if (needed > timeoutMs) timeoutMs = Math.min(needed, 60 * 60_000);
          }
          // Stall detection comes from policy unless the model asked for a
          // specific window.
          if (condition.stallSeconds === undefined) {
            condition = { ...condition, stallSeconds: ctx.policy.videoStallSeconds };
          }
        }

        const reply = await sendToFrame(tabId, frameId, {
          type: "wait_until",
          condition,
          timeoutMs,
        });
        if (!reply.ok) return fail(reply.error);
        if (reply.kind !== "wait") return fail("unexpected reply to wait_until");
        signal.pageChanged = true;
        return reply.met ? ok(reply.detail) : fail(reply.detail);
      }

      case "extract": {
        const reply = await sendToFrame(tabId, 0, { type: "extract", what: action.what });
        if (!reply.ok) return fail(reply.error);
        if (reply.kind !== "text") return fail("unexpected reply to extract");
        if (!reply.text.trim()) {
          return action.what === "transcript"
            ? fail("no transcript available on this page")
            : fail("no readable text found");
        }
        const text = reply.text.slice(0, 12000);
        signal.notes.push(`Extracted ${action.what} (${text.length} chars).`);
        return ok(`extracted ${action.what}`, text);
      }

      case "switch_tab": {
        await chrome.tabs.update(action.tabId, { active: true });
        signal.pageChanged = true;
        return ok(`switched to tab ${action.tabId}`);
      }

      case "remember": {
        const scopeKey =
          action.scope === "site"
            ? safeHost(ctx.snapshot.url)
            : action.scope === "course"
              ? ctx.courseKey
              : action.scope === "global"
                ? "global"
                : ctx.task.id;
        const row = await remember({
          taskId: ctx.task.id,
          kind: action.kind,
          scope: action.scope,
          scopeKey,
          text: action.text,
          // The agent is recording it, but the content came off the page.
          source: action.kind === "instruction" ? "page" : "agent",
          pinned: action.pin === true,
          url: ctx.snapshot.url,
        });
        return ok(
          `remembered (${row.kind}/${row.scope}${row.pinned ? ", pinned" : ""}): ${row.text.slice(0, 80)}`,
        );
      }

      case "recall": {
        const hits = await recall(action.query, [
          ctx.task.id,
          ctx.courseKey,
          safeHost(ctx.snapshot.url),
          "global",
        ]);
        if (!hits.length) return ok(`recall found nothing for "${action.query}"`);
        const text = hits.map((m) => `- (${m.kind}) ${m.text}`).join("\n");
        return ok(`recalled ${hits.length} item(s)`, text);
      }

      case "load_skill": {
        const skill = await getSkill(action.name);
        if (!skill) return fail(`no skill named "${action.name}"`);
        signal.loadSkill = skill.name;
        return ok(`loaded skill ${skill.name}`);
      }

      case "update_plan": {
        await setNodeStatus(action.nodeId, action.status, action.note);
        return ok(`plan node ${action.nodeId} -> ${action.status}`);
      }

      case "ask_human": {
        signal.ask = {
          kind: action.kind,
          question: action.question,
          options: action.options,
        };
        return ok(`asked the human: ${action.question.slice(0, 120)}`);
      }

      case "done": {
        signal.done = { summary: action.summary, success: action.success };
        return ok(`finished: ${action.summary.slice(0, 160)}`);
      }
    }
  } catch (err) {
    return fail(`${action.type} threw: ${String(err).slice(0, 200)}`);
  }
}

/** Resolves when the tab finishes loading, or after a ceiling. */
function waitForLoad(tabId: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      // Give the content script a moment to register after document_idle.
      setTimeout(resolve, 350);
    };
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo): void => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
}
