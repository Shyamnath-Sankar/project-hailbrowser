import { PORT_NAME, type PanelToWorker, type Rpc, type RpcResult, type WorkerToPanel } from "../shared/messages";
import type { Settings } from "../shared/types";
import { getSettings, saveSettings } from "./settings";
import { ensureSkillsSeeded, deleteSkill, listSkills, upsertSkill } from "./skills/router";
import * as store from "./memory/store";
import { db } from "./memory/db";
import {
  answerAsk,
  clearPause,
  isRunning,
  requestPause,
  requestStop,
  runTask,
  type OrchestratorEvent,
} from "./orchestrator";
import { captureSnapshot, sendToFrame } from "./perception";
import { callModel } from "./llm";
import { detach } from "./cdp/actions";

/**
 * Service worker entry. Holds no task state of its own: everything the loop
 * needs is in IndexedDB, so an eviction only costs the in-flight step.
 */

const ports = new Set<chrome.runtime.Port>();

function broadcast(msg: WorkerToPanel): void {
  for (const port of ports) {
    try {
      port.postMessage(msg);
    } catch {
      ports.delete(port);
    }
  }
}

/** Translates orchestrator events into panel messages. */
const emit = (event: OrchestratorEvent): void => {
  switch (event.type) {
    case "task":
      broadcast({ type: "task", task: event.task });
      break;
    case "plan":
      broadcast({ type: "plan", taskId: event.taskId, nodes: event.nodes });
      break;
    case "log":
      broadcast({ type: "log", taskId: event.taskId, level: event.level, text: event.text });
      break;
    case "ask":
      broadcast({ type: "ask", taskId: event.taskId, ask: event.ask });
      break;
    case "step":
      // The panel reads full step rows from the DB; this is the live nudge.
      broadcast({
        type: "log",
        taskId: event.taskId,
        level: "info",
        text: `#${event.index} ${event.step.next_goal}`,
      });
      void store
        .recentSteps(event.taskId, 1)
        .then((rows) => {
          const row = rows.at(-1);
          if (row) broadcast({ type: "step", step: row });
        })
        .catch(() => undefined);
      break;
  }
};

chrome.runtime.onInstalled.addListener(() => {
  void ensureSkillsSeeded();
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void chrome.alarms.create("watchdog", { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  void ensureSkillsSeeded();
  void chrome.alarms.create("watchdog", { periodInMinutes: 1 });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});

/**
 * The watchdog is what makes long tasks survive MV3. Chrome evicts an idle
 * service worker; the alarm wakes it and any task still marked running is
 * picked back up from its checkpoint.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "watchdog") return;
  void (async () => {
    await ensureSkillsSeeded();
    for (const task of await store.resumableTasks()) {
      if (!isRunning(task.id)) {
        broadcast({
          type: "log",
          taskId: task.id,
          level: "info",
          text: "Resuming after an idle pause.",
        });
        void runTask(task.id, emit);
      }
    }
  })();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  ports.add(port);

  port.onDisconnect.addListener(() => ports.delete(port));

  port.onMessage.addListener((msg: PanelToWorker) => {
    void handlePanelMessage(msg, port);
  });

  void (async () => {
    const [tasks, settings] = await Promise.all([store.listTasks(), getSettings()]);
    port.postMessage({ type: "state", tasks, settings } satisfies WorkerToPanel);
  })();
});

async function handlePanelMessage(msg: PanelToWorker, port: chrome.runtime.Port): Promise<void> {
  try {
    switch (msg.type) {
      case "start_task": {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        const task = await store.createTask(msg.goal, active?.id);
        await store.addChat(task.id, "user", msg.goal);
        port.postMessage({ type: "task", task } satisfies WorkerToPanel);
        void runTask(task.id, emit);
        break;
      }

      case "chat": {
        await store.addChat(msg.taskId, "user", msg.text);
        const task = await store.getTask(msg.taskId);
        // A message to a stopped task restarts it; to a live one it is picked
        // up at the next step without interrupting the current action.
        if (task && (task.status === "paused" || task.status === "failed")) {
          clearPause(msg.taskId);
          const updated = await store.patchTask(msg.taskId, { status: "running" });
          if (updated) broadcast({ type: "task", task: updated });
          void runTask(msg.taskId, emit);
        } else {
          broadcast({
            type: "log",
            taskId: msg.taskId,
            level: "info",
            text: "Noted. Applying it on the next step.",
          });
        }
        break;
      }

      case "answer_ask":
        await answerAsk(msg.taskId, msg.askId, msg.answer, emit);
        break;

      case "control": {
        if (msg.op === "pause") requestPause(msg.taskId);
        else if (msg.op === "stop") {
          requestStop(msg.taskId);
          const task = await store.getTask(msg.taskId);
          if (task?.tabId !== undefined) await detach(task.tabId);
          const updated = await store.patchTask(msg.taskId, { status: "cancelled" });
          if (updated) broadcast({ type: "task", task: updated });
        } else if (msg.op === "resume") {
          clearPause(msg.taskId);
          void runTask(msg.taskId, emit);
        } else if (msg.op === "takeover") {
          // Hand the tab back to the user: pause the loop and drop the debugger
          // so the automation banner goes away while they work.
          requestPause(msg.taskId);
          const task = await store.getTask(msg.taskId);
          if (task?.tabId !== undefined) await detach(task.tabId);
          broadcast({
            type: "log",
            taskId: msg.taskId,
            level: "info",
            text: "Handed the tab back to you. Press Resume when you are done.",
          });
        }
        break;
      }

      case "subscribe": {
        if (!msg.taskId) break;
        const [plan, memories, steps] = await Promise.all([
          store.getPlan(msg.taskId),
          store.listMemories(msg.taskId),
          store.recentSteps(msg.taskId, 40),
        ]);
        port.postMessage({ type: "plan", taskId: msg.taskId, nodes: plan } satisfies WorkerToPanel);
        port.postMessage({ type: "memories", taskId: msg.taskId, memories } satisfies WorkerToPanel);
        for (const step of steps) {
          port.postMessage({ type: "step", step } satisfies WorkerToPanel);
        }
        break;
      }

      case "get_state": {
        const [tasks, settings] = await Promise.all([store.listTasks(), getSettings()]);
        port.postMessage({ type: "state", tasks, settings } satisfies WorkerToPanel);
        break;
      }
    }
  } catch (err) {
    broadcast({
      type: "log",
      taskId: null,
      level: "error",
      text: err instanceof Error ? err.message : String(err),
    });
  }
}

/** One-shot RPC for things the panel reads on demand. */
chrome.runtime.onMessage.addListener((msg: Rpc, _sender, respond: (r: RpcResult) => void) => {
  void (async () => {
    try {
      switch (msg.kind) {
        case "get_settings":
          respond({ ok: true, data: await getSettings() });
          break;
        case "save_settings":
          respond({ ok: true, data: await saveSettings(msg.patch as Partial<Settings>) });
          break;
        case "list_tasks":
          respond({ ok: true, data: await store.listTasks() });
          break;
        case "get_task_detail": {
          const [task, plan, steps, chat, memories] = await Promise.all([
            store.getTask(msg.taskId),
            store.getPlan(msg.taskId),
            store.recentSteps(msg.taskId, 60),
            store.chatFor(msg.taskId),
            store.listMemories(msg.taskId),
          ]);
          respond({ ok: true, data: { task, plan, steps, chat, memories } });
          break;
        }
        case "list_memories":
          respond({ ok: true, data: await store.listMemories(msg.taskId) });
          break;
        case "forget_memory":
          await store.forgetMemory(msg.id);
          respond({ ok: true });
          break;
        case "pin_memory":
          await store.setPinned(msg.id, msg.pinned);
          respond({ ok: true });
          break;
        case "list_skills":
          await ensureSkillsSeeded();
          respond({ ok: true, data: await listSkills() });
          break;
        case "save_skill":
          await upsertSkill({ ...msg.skill, builtin: false });
          respond({ ok: true, data: await listSkills() });
          break;
        case "delete_skill":
          await deleteSkill(msg.name);
          respond({ ok: true, data: await listSkills() });
          break;
        case "overlay": {
          // Debug aid: draws the numbered boxes the model sees.
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id === undefined) throw new Error("no active tab");
          if (msg.show) await captureSnapshot(tab.id, false);
          const reply = await sendToFrame(tab.id, 0, { type: "overlay", show: msg.show });
          respond(reply.ok ? { ok: true } : { ok: false, error: reply.error });
          break;
        }
        case "test_role": {
          const settings = await getSettings();
          const started = Date.now();
          // A schema-constrained request, because that is what every real step
          // sends. Testing with a plain-text call passed on endpoints that then
          // failed on the first actual step.
          const res = await callModel(settings, msg.role, {
            system:
              'Reply with JSON only: {"ok":true,"word":"ready"}. No prose, no code fence.',
            messages: [{ role: "user", content: "Reply with the JSON object." }],
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["ok", "word"],
              properties: { ok: { type: "boolean" }, word: { type: "string" } },
            },
            maxTokens: 2000,
          });
          if (res.refusal) throw new Error(`The model declined: ${res.refusal}`);
          // Parsing here is the point: a reply we cannot parse is a failure, even
          // though the HTTP call succeeded.
          let word = "";
          try {
            const parsed = JSON.parse(res.text) as { word?: unknown };
            word = typeof parsed.word === "string" ? parsed.word : "";
          } catch {
            throw new Error(
              `Replied, but not with usable JSON, so the agent could not act on it. Got: ${res.text.slice(0, 160)}`,
            );
          }
          respond({
            ok: true,
            data: { text: word || "(empty)", usd: res.usd, ms: Date.now() - started },
          });
          break;
        }
      }
    } catch (err) {
      respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // async respond
});

/** Clean up the debugger when a task's tab closes. */
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await detach(tabId);
    const tasks = await store.resumableTasks();
    for (const task of tasks) {
      if (task.tabId !== tabId) continue;
      requestStop(task.id);
      const updated = await store.patchTask(task.id, {
        status: "paused",
        lastError: "The tab this task was using was closed.",
      });
      if (updated) broadcast({ type: "task", task: updated });
    }
  })();
});

// Keep Dexie warm so the first task step is not waiting on schema setup.
void db.open().catch(() => undefined);
