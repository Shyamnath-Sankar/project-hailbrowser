import { useEffect, useMemo, useState } from "react";
import { usePort } from "./usePort";
import { Chat } from "./tabs/Chat";
import { Plan } from "./tabs/Plan";
import { Timeline } from "./tabs/Timeline";
import { MemoryTab } from "./tabs/MemoryTab";
import { Skills } from "./tabs/Skills";
import { SettingsTab } from "./tabs/SettingsTab";
import type { Task } from "../shared/types";
import { isConfigured } from "../shared/credentials";

const TABS = ["Chat", "Plan", "Steps", "Memory", "Skills", "Settings"] as const;
type TabName = (typeof TABS)[number];

const LIVE: Task["status"][] = ["planning", "running", "waiting_human"];

export function App(): React.ReactElement {
  const { state, send, setSettings } = usePort();
  const [tab, setTab] = useState<TabName>("Chat");
  const [selected, setSelected] = useState<string | null>(null);

  // Follow the newest live task unless the user picked one explicitly.
  const task = useMemo<Task | undefined>(() => {
    if (selected) return state.tasks.find((t) => t.id === selected);
    return state.tasks.find((t) => LIVE.includes(t.status)) ?? state.tasks[0];
  }, [selected, state.tasks]);

  useEffect(() => {
    if (task) send({ type: "subscribe", taskId: task.id });
  }, [task?.id, send]);

  // Every role has to be able to run, not just one: a missing verifier key
  // would otherwise surface as a failure mid-task instead of here.
  const needsSetup = !isConfigured(state.settings);

  useEffect(() => {
    if (needsSetup) setTab("Settings");
  }, [needsSetup]);

  const plan = task ? (state.plans[task.id] ?? []) : [];
  const steps = task ? (state.steps[task.id] ?? []) : [];
  const logs = state.logs.filter((l) => !task || l.taskId === task.id || l.taskId === null);

  return (
    <>
      <div className="tabs" role="tablist">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            className="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {name}
            {name === "Plan" && plan.length > 0
              ? ` ${plan.filter((n) => n.status === "done").length}/${plan.length}`
              : ""}
          </button>
        ))}
      </div>

      {task && <TaskHeader task={task} send={send} tasks={state.tasks} onSelect={setSelected} />}

      {tab === "Chat" && (
        <Chat task={task} logs={logs} send={send} connected={state.connected} />
      )}
      {tab === "Plan" && <Plan nodes={plan} />}
      {tab === "Steps" && <Timeline steps={steps} />}
      {tab === "Memory" && <MemoryTab taskId={task?.id ?? null} />}
      {tab === "Skills" && <Skills />}
      {tab === "Settings" && (
        <SettingsTab settings={state.settings} onSaved={setSettings} needsSetup={needsSetup} />
      )}
    </>
  );
}

function TaskHeader({
  task,
  tasks,
  send,
  onSelect,
}: {
  task: Task;
  tasks: Task[];
  send: ReturnType<typeof usePort>["send"];
  onSelect: (id: string | null) => void;
}): React.ReactElement {
  const live = LIVE.includes(task.status);
  const spentPct = Math.min(100, (task.usdSpent / 5) * 100);

  return (
    <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
      <div className="row spread" style={{ marginBottom: 4 }}>
        <span className={`badge ${task.status}`}>{task.status.replace("_", " ")}</span>
        <span className="small dim mono">
          {task.stepCount} steps · ${task.usdSpent.toFixed(3)}
        </span>
      </div>

      <div className="small" style={{ marginBottom: 6, overflowWrap: "anywhere" }}>
        {task.goal}
      </div>

      <div className="meter" style={{ marginBottom: 6 }}>
        <div style={{ width: `${spentPct}%` }} />
      </div>

      <div className="row wrap">
        {live && (
          <button onClick={() => send({ type: "control", taskId: task.id, op: "pause" })}>
            Pause
          </button>
        )}
        {(task.status === "paused" || task.status === "failed") && (
          <button
            className="primary"
            onClick={() => send({ type: "control", taskId: task.id, op: "resume" })}
          >
            Resume
          </button>
        )}
        {live && (
          <button
            title="Pause and release the tab so you can act on it yourself"
            onClick={() => send({ type: "control", taskId: task.id, op: "takeover" })}
          >
            Take over
          </button>
        )}
        {live && (
          <button className="danger" onClick={() => send({ type: "control", taskId: task.id, op: "stop" })}>
            Stop
          </button>
        )}
        {tasks.length > 1 && (
          <select
            className="grow"
            value={task.id}
            onChange={(e) => onSelect(e.target.value)}
            aria-label="Switch task"
          >
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.goal.slice(0, 45)} ({t.status})
              </option>
            ))}
          </select>
        )}
      </div>

      {task.lastError && (
        <div className="small" style={{ color: "var(--err)", marginTop: 6 }}>
          {task.lastError}
        </div>
      )}
    </div>
  );
}
