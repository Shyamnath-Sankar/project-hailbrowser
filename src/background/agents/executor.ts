import type { AgentAction, AgentStep, Settings, WaitCondition } from "../../shared/types";
import { callModel } from "../llm";
import { extractJson } from "../llm/types";
import { AGENT_STEP_SCHEMA, EXECUTOR_SYSTEM, buildExecutorPrompt, type ContextInput } from "../context";

export interface ExecutorResult {
  step: AgentStep;
  usd: number;
}

/** One executor turn: fresh prompt in, validated step out. */
export async function runExecutor(
  settings: Settings,
  context: ContextInput,
  screenshotDataUrl?: string,
): Promise<ExecutorResult> {
  const prompt = buildExecutorPrompt(context);

  const res = await callModel(settings, "executor", {
    system: EXECUTOR_SYSTEM,
    messages: [{ role: "user", content: prompt, imageDataUrl: screenshotDataUrl }],
    schema: AGENT_STEP_SCHEMA,
    maxTokens: 8000,
  });

  if (res.refusal) throw new Error(`Executor declined: ${res.refusal}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(res.text));
  } catch {
    throw new Error(`Executor returned unparseable JSON: ${res.text.slice(0, 300)}`);
  }

  return { step: normalizeStep(parsed), usd: res.usd };
}

const ACTION_TYPES = new Set<AgentAction["type"]>([
  "navigate", "go_back", "click", "type", "select_option", "check", "press_key",
  "scroll", "hover", "media", "wait_until", "extract", "switch_tab", "remember",
  "recall", "load_skill", "update_plan", "ask_human", "done",
]);

/**
 * Validates the model's reply into an AgentStep. Unknown action types and
 * malformed fields are dropped rather than thrown, so one bad action in a batch
 * does not waste the whole turn.
 */
export function normalizeStep(raw: unknown): AgentStep {
  if (!raw || typeof raw !== "object") throw new Error("Executor reply was not an object");
  const obj = raw as Record<string, unknown>;

  const actionsRaw = Array.isArray(obj.actions) ? obj.actions : [];
  const actions: AgentAction[] = [];
  for (const item of actionsRaw.slice(0, 6)) {
    const action = normalizeAction(item);
    if (action) actions.push(action);
  }
  if (!actions.length) {
    throw new Error(
      `Executor returned no usable actions: ${JSON.stringify(actionsRaw).slice(0, 300)}`,
    );
  }

  return {
    evaluation_previous_step: str(obj.evaluation_previous_step, 500),
    memory: str(obj.memory, 1200),
    next_goal: str(obj.next_goal, 300) || "(no goal stated)",
    actions,
  };
}

function normalizeAction(item: unknown): AgentAction | null {
  if (!item || typeof item !== "object") return null;
  const a = item as Record<string, unknown>;
  const type = a.type;
  if (typeof type !== "string" || !ACTION_TYPES.has(type as AgentAction["type"])) return null;

  switch (type) {
    case "navigate": {
      const url = str(a.url, 2000);
      if (!/^https?:\/\//i.test(url)) return null;
      return { type, url, newTab: a.newTab === true };
    }
    case "go_back":
      return { type };
    case "click":
    case "hover": {
      const index = int(a.index);
      return index === null ? null : { type, index };
    }
    case "type": {
      const index = int(a.index);
      if (index === null) return null;
      return {
        type,
        index,
        text: str(a.text, 4000),
        clear: a.clear !== false,
        submit: a.submit === true,
      };
    }
    case "select_option": {
      const index = int(a.index);
      if (index === null) return null;
      return { type, index, value: str(a.value, 300) };
    }
    case "check": {
      const index = int(a.index);
      if (index === null) return null;
      return { type, index, checked: a.checked !== false };
    }
    case "press_key": {
      const key = str(a.key, 40);
      return key ? { type, key } : null;
    }
    case "scroll": {
      const direction = a.direction === "up" ? "up" : "down";
      const amount = int(a.amount);
      return amount === null ? { type, direction } : { type, direction, amount };
    }
    case "media": {
      const ops = ["play", "pause", "unmute", "rate", "captions", "seek_end"] as const;
      if (!ops.includes(a.op as (typeof ops)[number])) return null;
      const op = a.op as (typeof ops)[number];
      const rate = num(a.rate);
      return op === "rate" ? { type, op, rate: rate ?? 1 } : { type, op };
    }
    case "wait_until": {
      const condition = normalizeCondition(a.condition);
      if (!condition) return null;
      const timeout = int(a.timeoutMs) ?? 60_000;
      // Cap a single wait so a bad timeout cannot strand the task forever.
      return { type, condition, timeoutMs: Math.min(Math.max(timeout, 1000), 30 * 60_000) };
    }
    case "extract":
      return { type, what: a.what === "transcript" ? "transcript" : "markdown" };
    case "switch_tab": {
      const tabId = int(a.tabId);
      return tabId === null ? null : { type, tabId };
    }
    case "remember": {
      const text = str(a.text, 4000);
      if (!text) return null;
      const kinds = ["instruction", "fact", "note", "site_knowledge", "episode"] as const;
      const scopes = ["task", "course", "site", "global"] as const;
      const kind = kinds.includes(a.kind as (typeof kinds)[number])
        ? (a.kind as (typeof kinds)[number])
        : "note";
      const scope = scopes.includes(a.scope as (typeof scopes)[number])
        ? (a.scope as (typeof scopes)[number])
        : "task";
      return { type, kind, scope, text, pin: a.pin === true };
    }
    case "recall": {
      const query = str(a.query, 300);
      return query ? { type, query } : null;
    }
    case "load_skill": {
      const name = str(a.name, 80);
      return name ? { type, name } : null;
    }
    case "update_plan": {
      const nodeId = str(a.nodeId, 80);
      const statuses = ["todo", "active", "done", "skipped", "failed"] as const;
      if (!nodeId || !statuses.includes(a.status as (typeof statuses)[number])) return null;
      const note = str(a.note, 400);
      return {
        type,
        nodeId,
        status: a.status as (typeof statuses)[number],
        ...(note ? { note } : {}),
      };
    }
    case "ask_human": {
      const question = str(a.question, 1000);
      if (!question) return null;
      const kinds = ["login", "otp", "captcha", "confirm", "choice", "info"] as const;
      const kind = kinds.includes(a.kind as (typeof kinds)[number])
        ? (a.kind as (typeof kinds)[number])
        : "info";
      const options = Array.isArray(a.options)
        ? a.options.map((o) => str(o, 120)).filter(Boolean).slice(0, 6)
        : undefined;
      return { type, kind, question, ...(options?.length ? { options } : {}) };
    }
    case "done":
      return { type, summary: str(a.summary, 4000), success: a.success !== false };
    default:
      return null;
  }
}

function normalizeCondition(raw: unknown): WaitCondition | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case "video_ended": {
      const stall = int(c.stallSeconds);
      // A stall window under 10s trips on ordinary buffering.
      return stall === null
        ? { type: "video_ended" }
        : { type: "video_ended", stallSeconds: Math.min(Math.max(stall, 10), 600) };
    }
    case "url_changed": {
      const from = str(c.from, 2000);
      return from ? { type: "url_changed", from } : { type: "url_changed" };
    }
    case "selector_visible":
    case "selector_gone": {
      const selector = str(c.selector, 300);
      return selector ? { type: c.type, selector } : null;
    }
    case "text_present": {
      const text = str(c.text, 300);
      return text ? { type: "text_present", text } : null;
    }
    case "element_enabled": {
      const index = int(c.index);
      return index === null ? null : { type: "element_enabled", index };
    }
    default:
      return null;
  }
}

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : "";

function int(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
