/** Message envelopes for sidepanel <-> service worker <-> content script. */
import type {
  AgentAction,
  ActionResult,
  AgentRole,
  AskHuman,
  MediaOp,
  Memory,
  PageSnapshot,
  PlanNode,
  Settings,
  StepRecord,
  Task,
  WaitCondition,
} from "./types";


/** Side panel -> service worker, over a long-lived port. */
export type PanelToWorker =
  | { type: "start_task"; goal: string }
  | { type: "chat"; taskId: string; text: string }
  | { type: "answer_ask"; taskId: string; askId: string; answer: string }
  | { type: "control"; taskId: string; op: "pause" | "resume" | "stop" | "takeover" }
  | { type: "subscribe"; taskId: string | null }
  | { type: "get_state" };

/** Service worker -> side panel. */
export type WorkerToPanel =
  | { type: "state"; tasks: Task[]; settings: Settings }
  | { type: "task"; task: Task }
  | { type: "plan"; taskId: string; nodes: PlanNode[] }
  | { type: "step"; step: StepRecord }
  | { type: "log"; taskId: string | null; level: "info" | "warn" | "error"; text: string }
  | { type: "ask"; taskId: string; ask: AskHuman }
  | { type: "memories"; taskId: string | null; memories: Memory[] };

/** Service worker -> content script. Replies are the matching *Reply below. */
export type WorkerToContent =
  | { type: "snapshot"; wantText: boolean; startIndex: number; frameId: number }
  | { type: "wait_until"; condition: WaitCondition; timeoutMs: number }
  | { type: "media"; op: MediaOp; rate?: number }
  | { type: "extract"; what: "markdown" | "transcript" }
  | { type: "overlay"; show: boolean }
  | { type: "resolve_index"; index: number }
  | { type: "set_value"; index: number; value: string; kind: "select" | "check" };

export type ContentReply =
  | { ok: true; kind: "snapshot"; snapshot: PageSnapshot }
  | { ok: true; kind: "text"; text: string }
  | { ok: true; kind: "wait"; met: boolean; detail: string }
  | { ok: true; kind: "media"; applied: boolean; detail: string }
  | { ok: true; kind: "void" }
  | { ok: false; error: string };

export const PORT_NAME = "project-browser-panel";

/** Runtime message used by the alarm watchdog to nudge a stalled loop. */
export interface ResumeSignal {
  type: "resume_tasks";
}

export type ActionOutcome = { action: AgentAction; result: ActionResult };

/* ------------------------------ request/response ----------------------------- */
/** One-shot RPC from the side panel, separate from the streaming port. */
export type Rpc =
  | { kind: "get_settings" }
  | { kind: "save_settings"; patch: Partial<Settings> }
  | { kind: "list_tasks" }
  | { kind: "get_task_detail"; taskId: string }
  | { kind: "list_memories"; taskId: string | null }
  | { kind: "forget_memory"; id: string }
  | { kind: "pin_memory"; id: string; pinned: boolean }
  | { kind: "list_skills" }
  | { kind: "save_skill"; skill: SkillLike }
  | { kind: "delete_skill"; name: string }
  | { kind: "overlay"; show: boolean }
  /** Sends a one-token ping using exactly this role's own configuration. */
  | { kind: "test_role"; role: AgentRole };

export interface SkillLike {
  name: string;
  pageTypes: string[];
  hosts: string[];
  description: string;
  body: string;
  builtin: boolean;
}

export type RpcResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };
