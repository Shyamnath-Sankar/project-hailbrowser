import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PORT_NAME, type PanelToWorker, type WorkerToPanel } from "../shared/messages";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { Memory, PlanNode, Settings, StepRecord, Task } from "../shared/types";

export interface LogLine {
  id: number;
  taskId: string | null;
  level: "info" | "warn" | "error";
  text: string;
  at: number;
}

export interface PortState {
  connected: boolean;
  tasks: Task[];
  settings: Settings;
  plans: Record<string, PlanNode[]>;
  steps: Record<string, StepRecord[]>;
  memories: Record<string, Memory[]>;
  logs: LogLine[];
}

/**
 * Keeps a long-lived port to the service worker. The port is also what tells
 * the worker a panel is open, so it reconnects if the worker is recycled.
 */
export function usePort(): {
  state: PortState;
  send: (msg: PanelToWorker) => void;
  setSettings: (settings: Settings) => void;
} {
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const logId = useRef(0);

  const [state, setState] = useState<PortState>({
    connected: false,
    tasks: [],
    settings: DEFAULT_SETTINGS,
    plans: {},
    steps: {},
    memories: {},
    logs: [],
  });

  const apply = useCallback((msg: WorkerToPanel) => {
    setState((prev) => {
      switch (msg.type) {
        case "state":
          return { ...prev, tasks: msg.tasks, settings: msg.settings };

        case "task": {
          const others = prev.tasks.filter((t) => t.id !== msg.task.id);
          return { ...prev, tasks: [msg.task, ...others] };
        }

        case "plan":
          return { ...prev, plans: { ...prev.plans, [msg.taskId]: msg.nodes } };

        case "step": {
          const existing = prev.steps[msg.step.taskId] ?? [];
          // Steps can arrive twice (live nudge plus a subscribe replay).
          const deduped = existing.filter((s) => s.index !== msg.step.index);
          const next = [...deduped, msg.step].sort((a, b) => a.index - b.index);
          return { ...prev, steps: { ...prev.steps, [msg.step.taskId]: next } };
        }

        case "memories":
          return {
            ...prev,
            memories: { ...prev.memories, [msg.taskId ?? "all"]: msg.memories },
          };

        case "ask": {
          const line: LogLine = {
            id: ++logId.current,
            taskId: msg.taskId,
            level: "warn",
            text: `Waiting on you: ${msg.ask.question}`,
            at: Date.now(),
          };
          return { ...prev, logs: [...prev.logs, line].slice(-300) };
        }

        case "log": {
          const line: LogLine = {
            id: ++logId.current,
            taskId: msg.taskId,
            level: msg.level,
            text: msg.text,
            at: Date.now(),
          };
          return { ...prev, logs: [...prev.logs, line].slice(-300) };
        }
      }
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let retry: number | undefined;

    const connect = (): void => {
      if (disposed) return;
      const port = chrome.runtime.connect({ name: PORT_NAME });
      portRef.current = port;
      setState((prev) => ({ ...prev, connected: true }));

      port.onMessage.addListener((msg: WorkerToPanel) => apply(msg));
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        setState((prev) => ({ ...prev, connected: false }));
        // The worker was evicted. Reconnecting also wakes it back up.
        if (!disposed) retry = self.setTimeout(connect, 800);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retry !== undefined) clearTimeout(retry);
      portRef.current?.disconnect();
    };
  }, [apply]);

  const send = useCallback((msg: PanelToWorker) => {
    try {
      portRef.current?.postMessage(msg);
    } catch {
      // Dropped because the worker restarted; the reconnect will re-sync.
    }
  }, []);

  const setSettings = useCallback((settings: Settings) => {
    setState((prev) => ({ ...prev, settings }));
  }, []);

  return useMemo(() => ({ state, send, setSettings }), [state, send, setSettings]);
}
