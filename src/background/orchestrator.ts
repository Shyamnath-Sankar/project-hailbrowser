import type {
  ActionResult,
  AgentStep,
  AskHuman,
  PageSnapshot,
  PlanNode,
  Settings,
  Task,
} from "../shared/types";
import { getSettings } from "./settings";
import { captureSnapshot, snapshotFingerprint } from "./perception";
import { dispatch } from "./dispatch";
import { runExecutor } from "./agents/executor";
import { makePlan } from "./agents/planner";
import { verifyMilestone } from "./agents/verifier";
import { candidateSkills, getSkill, safeHost } from "./skills/router";
import { newId, type SkillRow } from "./memory/db";
import * as store from "./memory/store";
import { grantFrom } from "../shared/approvals";
import * as cdp from "./cdp/actions";
import { MissingKeyError } from "./llm";

/**
 * The task engine. One loop per task, all state in IndexedDB so the loop can be
 * killed at any point (service worker eviction, browser restart) and resume from
 * its last checkpoint.
 */

export type Emit = (event: OrchestratorEvent) => void;

export type OrchestratorEvent =
  | { type: "task"; task: Task }
  | { type: "plan"; taskId: string; nodes: PlanNode[] }
  | { type: "step"; taskId: string; step: AgentStep; results: ActionResult[]; index: number; url: string }
  | { type: "log"; taskId: string | null; level: "info" | "warn" | "error"; text: string }
  | { type: "ask"; taskId: string; ask: AskHuman };

interface RunState {
  scratchpad: string;
  loadedSkills: string[];
  /** Fingerprints of recent pages, for the stuck detector. */
  recentFingerprints: string[];
  /** Data returned by extract/recall, carried into the next prompt only. */
  carry: string[];
  stepsSinceVerify: number;
  startedAt: number;
}

const running = new Map<string, boolean>();
const cancelled = new Set<string>();
const paused = new Set<string>();

export const isRunning = (taskId: string): boolean => running.get(taskId) === true;

export function requestPause(taskId: string): void {
  paused.add(taskId);
}

export function requestStop(taskId: string): void {
  cancelled.add(taskId);
  paused.delete(taskId);
}

export function clearPause(taskId: string): void {
  paused.delete(taskId);
  cancelled.delete(taskId);
}

/** Starts a task loop if one is not already running for it. */
export async function runTask(taskId: string, emit: Emit): Promise<void> {
  if (running.get(taskId)) return;
  running.set(taskId, true);
  try {
    await loop(taskId, emit);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    emit({ type: "log", taskId, level: "error", text });
    const task = await store.patchTask(taskId, { status: "failed", lastError: text });
    if (task) emit({ type: "task", task });
  } finally {
    running.delete(taskId);
    cancelled.delete(taskId);
    paused.delete(taskId);
  }
}

async function loop(taskId: string, emit: Emit): Promise<void> {
  let task = await store.getTask(taskId);
  if (!task) throw new Error("task not found");

  const settings = await getSettings();
  let tabId = await resolveTab(task);
  if (tabId !== task.tabId) task = (await store.patchTask(taskId, { tabId })) ?? task;

  await cdp.attach(tabId).catch((err) => {
    throw new Error(
      `Could not attach the debugger to this tab (${String(err).slice(0, 120)}). Close any open DevTools on it and try again.`,
    );
  });

  const checkpoint = await store.loadCheckpoint(taskId);
  const state: RunState = {
    scratchpad: checkpoint?.scratchpad ?? "",
    loadedSkills: checkpoint?.loadedSkills ?? [],
    recentFingerprints: [],
    carry: [],
    stepsSinceVerify: 0,
    startedAt: Date.now(),
  };

  let stepIndex = (checkpoint?.stepIndex ?? -1) + 1;

  // Plan on a fresh task, or when a resumed task never got one.
  let plan = await store.getPlan(taskId);
  if (!plan.length) {
    emit({ type: "log", taskId, level: "info", text: "Mapping the goal into a plan..." });
    const snapshot = await captureSnapshot(tabId, true);
    const result = await makePlan(settings, task, snapshot, {
      existing: [],
      reason: "New task. Build the initial plan.",
      notes: [],
    });
    plan = result.nodes;
    task = (await store.patchTask(taskId, { usdSpent: task.usdSpent + result.usd })) ?? task;
    emit({ type: "plan", taskId, nodes: plan });
  }

  task = (await store.patchTask(taskId, { status: "running" })) ?? task;
  emit({ type: "task", task });

  let consecutiveFailures = 0;

  for (;;) {
    task = (await store.getTask(taskId)) ?? task;

    if (cancelled.has(taskId)) {
      const updated = await store.patchTask(taskId, { status: "cancelled" });
      if (updated) emit({ type: "task", task: updated });
      emit({ type: "log", taskId, level: "info", text: "Task stopped." });
      return;
    }

    if (paused.has(taskId)) {
      const updated = await store.patchTask(taskId, { status: "paused" });
      if (updated) emit({ type: "task", task: updated });
      emit({ type: "log", taskId, level: "info", text: "Task paused." });
      return;
    }

    const budget = checkBudget(task, settings, state, stepIndex);
    if (budget) {
      const ask: AskHuman = {
        id: newId("ask"),
        kind: "confirm",
        question: `${budget} Continue anyway?`,
        options: ["Continue", "Stop here"],
        askedAt: Date.now(),
      };
      const updated = await store.patchTask(taskId, { status: "waiting_human", pendingAsk: ask });
      if (updated) emit({ type: "task", task: updated });
      emit({ type: "ask", taskId, ask });
      await notify("Budget reached", budget);
      return;
    }

    // Fold in anything the user typed while the task was running.
    const pending = await store.unconsumedUserChat(taskId);
    const userMessages = pending.map((c) => c.text);
    if (pending.length) await store.markChatConsumed(pending.map((c) => c.id));

    const snapshot = await captureSnapshot(tabId, true);

    const fingerprint = snapshotFingerprint(snapshot);
    state.recentFingerprints.push(fingerprint);
    if (state.recentFingerprints.length > 6) state.recentFingerprints.shift();
    const repeats = state.recentFingerprints.filter((f) => f === fingerprint).length;

    let stuckHint: string | undefined;
    if (repeats >= 3) {
      stuckHint = `The page has not changed across ${repeats} steps. What you are trying is not working. Do something different: scroll to find the control, reload, take another route, or ask_human. Do not repeat the last action.`;
    }

    if (repeats >= 4) {
      // Replanning is the heavier remedy, so it only fires once the hint failed.
      emit({ type: "log", taskId, level: "warn", text: "Stuck. Replanning." });
      const notes = [
        `Stuck at ${snapshot.url} (page type ${snapshot.pageType}).`,
        state.scratchpad.slice(-800),
      ].filter(Boolean);
      const replan = await makePlan(settings, task, snapshot, {
        existing: plan,
        reason: "The executor is stuck repeating the same page. Repair the plan, or route around the blocked step.",
        notes,
      });
      plan = replan.nodes;
      task = (await store.patchTask(taskId, { usdSpent: task.usdSpent + replan.usd })) ?? task;
      emit({ type: "plan", taskId, nodes: plan });
      state.recentFingerprints = [];
    }

    const activeNode = await store.nextPendingNode(taskId);
    if (activeNode && activeNode.status === "todo") {
      await store.setNodeStatus(activeNode.id, "active");
      activeNode.status = "active";
    }
    if (!activeNode && plan.length && plan.every((n) => n.status !== "todo" && n.status !== "active")) {
      // Every node resolved. Let the executor confirm and finish.
      state.scratchpad = appendNote(
        state.scratchpad,
        "All plan nodes are resolved. Verify the overall goal is met, then call done.",
      );
    }

    const courseKey = courseKeyFor(task, snapshot);
    const scopeKeys = [task.id, courseKey, safeHost(snapshot.url), "global"];
    const pinned = await store.pinnedFor(scopeKeys);
    const recalled = activeNode
      ? await store.recall(`${activeNode.title} ${snapshot.title}`, scopeKeys, 5)
      : [];

    const candidates = await candidateSkills(snapshot.pageType, snapshot.url);
    const loaded: SkillRow[] = [];
    for (const name of state.loadedSkills) {
      const skill = await getSkill(name);
      if (skill) loaded.push(skill);
    }

    const recent = await store.recentSteps(taskId, 8);
    const wantScreenshot =
      settings.vision === "always" ||
      (settings.vision === "auto" &&
        (snapshot.elements.length === 0 ||
          repeats >= 2 ||
          snapshot.pageType === "captcha" ||
          recent.at(-1)?.results.some((r) => !r.ok) === true));

    const screenshot = wantScreenshot
      ? await cdp.screenshot(tabId).catch(() => undefined)
      : undefined;

    const scratch = state.carry.length
      ? appendNote(state.scratchpad, state.carry.join("\n").slice(0, 4000))
      : state.scratchpad;
    state.carry = [];

    const { step, usd } = await runExecutor(
      settings,
      {
        task,
        plan,
        activeNode,
        pinned,
        recalled,
        recentSteps: recent,
        snapshot,
        candidateSkills: candidates,
        loadedSkills: loaded,
        scratchpad: scratch,
        userMessages,
        policy: settings.policy,
        stuckHint,
      },
      screenshot,
    );

    const { results, signal } = await dispatch(step.actions, {
      task,
      tabId,
      snapshot,
      policy: settings.policy,
      courseKey,
    });

    // Persist the step before reacting to it, so a crash here still resumes.
    await store.addStep({
      taskId,
      index: stepIndex,
      at: Date.now(),
      evaluation: step.evaluation_previous_step,
      memory: step.memory,
      nextGoal: step.next_goal,
      actions: step.actions,
      results,
      url: snapshot.url,
      usd,
    });

    state.scratchpad = appendNote(state.scratchpad, step.memory);
    for (const note of signal.notes) state.scratchpad = appendNote(state.scratchpad, note);
    for (const result of results) {
      if (result.data) state.carry.push(result.data.slice(0, 6000));
    }

    if (signal.loadSkill && !state.loadedSkills.includes(signal.loadSkill)) {
      state.loadedSkills.push(signal.loadSkill);
      // Keep at most three skill bodies in context at once.
      if (state.loadedSkills.length > 3) state.loadedSkills.shift();
    }

    // Spend any one-shot approval this turn used, so the next identical action
    // asks again rather than inheriting a stale yes.
    let approvals = task.approvals;
    if (signal.consumedApprovals.length > 0 && approvals) {
      approvals = { ...approvals };
      for (const key of signal.consumedApprovals) delete approvals[key];
    }

    if (signal.switchTab !== undefined && signal.switchTab !== tabId) {
      const previous = tabId;
      tabId = signal.switchTab;
      await cdp.detach(previous).catch(() => undefined);
      await cdp.attach(tabId).catch((err) => {
        emit({
          type: "log",
          taskId,
          level: "warn",
          text: `Could not attach to the new tab: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }

    task =
      (await store.patchTask(taskId, {
        stepCount: stepIndex + 1,
        usdSpent: task.usdSpent + usd,
        approvals,
        tabId,
      })) ?? task;

    await store.saveCheckpoint({
      taskId,
      stepIndex,
      url: snapshot.url,
      activeNodeId: activeNode?.id ?? null,
      scratchpad: state.scratchpad.slice(-6000),
      loadedSkills: state.loadedSkills,
      at: Date.now(),
    });

    emit({ type: "step", taskId, step, results, index: stepIndex, url: snapshot.url });
    emit({ type: "task", task });
    plan = await store.getPlan(taskId);
    emit({ type: "plan", taskId, nodes: plan });

    stepIndex++;

    const failed = results.filter((r) => !r.ok);
    consecutiveFailures = failed.length === results.length && results.length > 0
      ? consecutiveFailures + 1
      : 0;

    if (consecutiveFailures >= 6) {
      const ask: AskHuman = {
        id: newId("ask"),
        kind: "info",
        question: `I have failed ${consecutiveFailures} steps in a row on ${snapshot.url}. Last error: ${failed.at(-1)?.detail ?? "unknown"}. How should I proceed?`,
        askedAt: Date.now(),
      };
      const updated = await store.patchTask(taskId, { status: "waiting_human", pendingAsk: ask });
      if (updated) emit({ type: "task", task: updated });
      emit({ type: "ask", taskId, ask });
      await notify("Agent needs help", ask.question.slice(0, 120));
      return;
    }

    if (signal.ask) {
      const ask: AskHuman = { ...signal.ask, id: newId("ask"), askedAt: Date.now() };
      const updated = await store.patchTask(taskId, { status: "waiting_human", pendingAsk: ask });
      if (updated) emit({ type: "task", task: updated });
      emit({ type: "ask", taskId, ask });
      await notify("Agent needs you", ask.question.slice(0, 120));
      return;
    }

    if (signal.done) {
      // Verify a success claim before believing it.
      let accepted = signal.done.success;
      let reason = "";
      if (signal.done.success) {
        const after = await captureSnapshot(tabId, true);
        const check = await verifyMilestone(settings, `Goal "${task.goal}" is complete: ${signal.done.summary}`, after);
        task = (await store.patchTask(taskId, { usdSpent: task.usdSpent + check.usd })) ?? task;
        accepted = check.verified;
        reason = check.reason;
      }

      if (accepted) {
        const updated = await store.patchTask(taskId, { status: "done" });
        if (updated) emit({ type: "task", task: updated });
        await store.addChat(taskId, "agent", signal.done.summary);
        emit({ type: "log", taskId, level: "info", text: `Done: ${signal.done.summary}` });
        await notify("Task finished", signal.done.summary.slice(0, 120));
        return;
      }

      emit({
        type: "log",
        taskId,
        level: "warn",
        text: `Claimed done, but verification disagreed: ${reason}`,
      });
      state.scratchpad = appendNote(
        state.scratchpad,
        `You called done, but verification rejected it: ${reason}. Keep working, or call done with success false if it truly cannot be completed.`,
      );
      continue;
    }

    // Periodic milestone verification, so drift is caught before it compounds.
    state.stepsSinceVerify++;
    const finishedNode = results.some(
      (r, i) => r.ok && step.actions[i]?.type === "update_plan",
    );
    if (finishedNode && state.stepsSinceVerify >= 3) {
      state.stepsSinceVerify = 0;
      const after = await captureSnapshot(tabId, false);
      const check = await verifyMilestone(
        settings,
        `Progress claim: ${step.next_goal} (${step.memory})`,
        after,
      );
      task = (await store.patchTask(taskId, { usdSpent: task.usdSpent + check.usd })) ?? task;
      if (!check.verified) {
        state.scratchpad = appendNote(
          state.scratchpad,
          `Verification doubt: ${check.reason}. Confirm the last item really registered before moving on.`,
        );
      }
    }

    // Yield so message handling and the watchdog get a turn.
    await cdp.pause(150);
  }
}

/** Resumes a task after the human answered an ask_human. */
export async function answerAsk(
  taskId: string,
  askId: string,
  answer: string,
  emit: Emit,
): Promise<void> {
  const task = await store.getTask(taskId);
  if (!task || task.pendingAsk?.id !== askId) return;

  const ask = task.pendingAsk;
  const reply = answer.trim();

  await store.remember({
    taskId,
    kind: "instruction",
    scope: "task",
    scopeKey: taskId,
    // The human answered, so this carries user authority.
    text: `Human answered "${ask.question}" with: ${reply}`,
    source: "user",
    pinned: true,
  });

  // An ask that gates one action records a decision about that action. Without
  // this the gate re-asks the identical question on the very next step.
  let approvals = task.approvals;
  if (ask.approvalKey) {
    const grant = grantFrom(reply);
    approvals = { ...(task.approvals ?? {}), [ask.approvalKey]: grant };
    emit({
      type: "log",
      taskId,
      level: "info",
      text:
        grant.mode === "denied"
          ? "Noted. Skipping that action and carrying on."
          : grant.mode === "always"
            ? "Noted. I will not ask about that one again."
            : "Noted. Going ahead with it.",
    });
  }

  // Only an explicit stop ends the task. A plain "no" is an answer to the
  // question asked, not an instruction to abandon hours of work - and declining
  // one irreversible click must leave the rest of the plan intact.
  const stopping = !ask.approvalKey && /^(stop|cancel|abort|quit)\b/i.test(reply);

  const updated = await store.patchTask(taskId, {
    status: stopping ? "cancelled" : "running",
    pendingAsk: undefined,
    approvals,
  });
  if (updated) emit({ type: "task", task: updated });
  if (stopping) return;

  clearPause(taskId);
  void runTask(taskId, emit);
}

function checkBudget(
  task: Task,
  settings: Settings,
  state: RunState,
  stepIndex: number,
): string | null {
  const { policy } = settings;
  if (task.usdSpent >= policy.maxUsd) {
    return `Spent $${task.usdSpent.toFixed(2)} of the $${policy.maxUsd.toFixed(2)} budget.`;
  }
  if (stepIndex >= policy.maxSteps) return `Reached the ${policy.maxSteps}-step limit.`;
  const minutes = (Date.now() - state.startedAt) / 60_000;
  if (minutes >= policy.maxMinutes) {
    return `Ran for ${Math.round(minutes)} minutes, past the ${policy.maxMinutes}-minute limit.`;
  }
  return null;
}

/** A stable key for "this course", so notes survive across its pages. */
function courseKeyFor(task: Task, snapshot: PageSnapshot): string {
  const host = safeHost(snapshot.url);
  return host ? `course:${host}:${task.id.slice(-6)}` : `course:${task.id}`;
}

function appendNote(scratchpad: string, note: string): string {
  const trimmed = note.trim();
  if (!trimmed) return scratchpad;
  const lines = `${scratchpad}\n${trimmed}`.split("\n").filter(Boolean);
  // Keep the tail: recent notes matter more, and this bounds the prompt.
  return lines.slice(-40).join("\n");
}

async function resolveTab(task: Task): Promise<number> {
  if (task.tabId !== undefined) {
    const existing = await chrome.tabs.get(task.tabId).catch(() => undefined);
    if (existing?.id !== undefined) return existing.id;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== undefined && (active.url ?? "").startsWith("http")) return active.id;
  const created = await chrome.tabs.create({ url: "about:blank", active: true });
  if (created.id === undefined) throw new Error("could not open a tab for this task");
  return created.id;
}

async function notify(title: string, message: string): Promise<void> {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icon128.png",
      title,
      message,
    });
  } catch {
    // Notifications are a convenience; never let one break the loop.
  }
}

export { MissingKeyError };
