/** Core domain types shared by the service worker, content scripts and side panel. */

export type ProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "openrouter"
  | "ollama"
  | "openai_compatible";
export type AgentRole = "planner" | "executor" | "verifier";

/**
 * Shared per-provider credentials. Kept as the fallback behind per-role values,
 * and as the home for settings saved by earlier versions.
 */
export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface RoleModel {
  provider: ProviderId;
  model: string;
  /** Anthropic-style effort hint. Ignored by providers that lack it. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Credentials for this role specifically. Each role carries its own so that
   * two roles on the same provider - two different OpenAI-compatible endpoints,
   * say - do not overwrite each other.
   *
   * Left unset, a role borrows from another role on the same provider, then from
   * the shared `providers` map. That way a single Anthropic key need only be
   * typed once even though three roles use it.
   */
  apiKey?: string;
  baseUrl?: string;
}

/** What the agent is allowed to do without stopping to ask. */
export interface Policy {
  /** Pause before anything that submits, sends, buys or deletes. */
  confirmBeforeSubmit: boolean;
  /** graded tests: ask the human, let the agent answer, or skip the item. */
  quizPolicy: "ask" | "auto" | "skip";
  /**
   * How to get through a lesson video.
   * "skip": jump to the end, then confirm the lesson registered as complete and
   * fall back to watching if it did not. Fast, but not every player credits it.
   * "watch": play it through at `videoRate`.
   */
  videoStrategy: "skip" | "watch";
  /**
   * Playback rate when watching. Many players cap or reset this, so the agent
   * applies it, reads back what actually took effect, and proceeds with the real
   * rate rather than assuming.
   */
  videoRate: number;
  /** Turn captions on when available, so a transcript can be extracted. */
  videoCaptions: boolean;
  /**
   * Seconds of no playback progress before the agent stops waiting and looks at
   * the page. This is what turns a silent 20-minute timeout into a 45-second
   * recovery when an overlay or ad blocks the player.
   */
  videoStallSeconds: number;
  maxUsd: number;
  maxSteps: number;
  maxMinutes: number;
}

export interface Settings {
  /**
   * Run all three roles on one model. The planner slot is the source of truth
   * and the other two mirror it, so there is one thing to configure and test.
   */
  linkRoles: boolean;
  providers: Partial<Record<ProviderId, ProviderConfig>>;
  roles: Record<AgentRole, RoleModel>;
  policy: Policy;
  /** Send screenshots to the model. "auto" only sends them when text is not enough. */
  vision: "auto" | "always" | "never";
}

export type TaskStatus =
  | "planning"
  | "running"
  | "waiting_human"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  tabId?: number;
  stepCount: number;
  usdSpent: number;
  /** Set while status === "waiting_human". */
  pendingAsk?: AskHuman;
  /**
   * Decisions the human has made about specific actions, keyed by action
   * signature. "once" is consumed by the next matching action; "always" and
   * "denied" persist for the life of the task. Without this the confirm gate
   * re-asks on every step, because nothing records that the human already said yes.
   */
  approvals?: Record<string, ApprovalGrant>;
  lastError?: string;
}

export type NodeStatus = "todo" | "active" | "done" | "skipped" | "failed";

export interface PlanNode {
  id: string;
  taskId: string;
  parentId: string | null;
  title: string;
  status: NodeStatus;
  order: number;
  /** Set for leaves the agent identified as a graded item. */
  graded?: boolean;
  note?: string;
}

export interface ApprovalGrant {
  mode: "once" | "always" | "denied";
  at: number;
  /** Shown back to the model, e.g. that the human performed the action itself. */
  note?: string;
}

export interface AskHuman {
  id: string;
  kind: "login" | "otp" | "captcha" | "confirm" | "choice" | "info";
  question: string;
  options?: string[];
  /**
   * Set when this ask gates one specific action. The human's reply is recorded
   * against this key so the gate can see the decision on the next step instead of
   * asking again, which is otherwise an infinite loop.
   */
  approvalKey?: string;
  /** Filled in when the human answers. */
  answer?: string;
  askedAt: number;
  answeredAt?: number;
}

export type MemoryKind = "instruction" | "fact" | "note" | "site_knowledge" | "episode";
export type MemoryScope = "task" | "course" | "site" | "global";
/** Where the text came from. Page-sourced memories never carry authority. */
export type MemorySource = "user" | "page" | "agent";

export interface Memory {
  id: string;
  taskId: string | null;
  kind: MemoryKind;
  scope: MemoryScope;
  /** Scope key: origin for "site", course/task id for "course". */
  scopeKey: string;
  text: string;
  source: MemorySource;
  /** Pinned memories are injected into every prompt within their scope. */
  pinned: boolean;
  createdAt: number;
  url?: string;
}

/** One executor iteration, persisted so a task survives a worker restart. */
export interface StepRecord {
  id: string;
  taskId: string;
  index: number;
  at: number;
  evaluation: string;
  memory: string;
  nextGoal: string;
  actions: AgentAction[];
  results: ActionResult[];
  url: string;
  screenshotRef?: string;
  usd: number;
}

export interface Checkpoint {
  taskId: string;
  stepIndex: number;
  url: string;
  activeNodeId: string | null;
  scratchpad: string;
  loadedSkills: string[];
  at: number;
}

/* ---------------------------------- actions --------------------------------- */

export type MediaOp =
  | "play"
  | "pause"
  | "unmute"
  | "rate"
  | "captions"
  /**
   * Jump to the end of the video instead of watching it. Works on players that
   * credit a lesson from the `ended` event; players that report progress with
   * periodic beacons, or that lock seeking ahead of watched content, will not
   * count it - so the agent verifies completion afterwards either way.
   */
  | "seek_end";

export type WaitCondition =
  /**
   * Waits for playback to finish, but gives up early if the video stops making
   * progress for `stallSeconds` - an overlay, an ad, or a buffering failure.
   * Returning early with the real position beats burning the whole timeout.
   */
  | { type: "video_ended"; stallSeconds?: number }
  | { type: "url_changed"; from?: string }
  | { type: "selector_visible"; selector: string }
  | { type: "selector_gone"; selector: string }
  | { type: "text_present"; text: string }
  | { type: "element_enabled"; index: number };

export type AgentAction =
  | { type: "navigate"; url: string; newTab?: boolean }
  | { type: "go_back" }
  | { type: "click"; index: number }
  | { type: "type"; index: number; text: string; clear?: boolean; submit?: boolean }
  | { type: "select_option"; index: number; value: string }
  | { type: "check"; index: number; checked: boolean }
  | { type: "press_key"; key: string }
  | { type: "scroll"; direction: "up" | "down"; amount?: number }
  | { type: "hover"; index: number }
  | { type: "media"; op: MediaOp; rate?: number }
  | { type: "wait_until"; condition: WaitCondition; timeoutMs: number }
  | { type: "extract"; what: "markdown" | "transcript" }
  | { type: "switch_tab"; tabId: number }
  | { type: "remember"; kind: MemoryKind; scope: MemoryScope; text: string; pin?: boolean }
  | { type: "recall"; query: string }
  | { type: "load_skill"; name: string }
  | { type: "update_plan"; nodeId: string; status: NodeStatus; note?: string }
  | { type: "ask_human"; kind: AskHuman["kind"]; question: string; options?: string[] }
  | { type: "done"; summary: string; success: boolean };

export interface ActionResult {
  ok: boolean;
  /** Short, model-facing description of what happened. */
  detail: string;
  /** Payload for actions that return data (extract, recall). */
  data?: string;
}

/** The structured reply every executor turn must produce. */
export interface AgentStep {
  evaluation_previous_step: string;
  memory: string;
  next_goal: string;
  actions: AgentAction[];
}

/* -------------------------------- perception -------------------------------- */

export type PageType =
  | "video"
  | "reading"
  | "quiz"
  | "instructions"
  | "form"
  | "login"
  | "captcha"
  | "listing"
  | "unknown";

export interface IndexedElement {
  index: number;
  tag: string;
  role?: string;
  label: string;
  value?: string;
  /** Viewport-relative box, used for coordinate fallbacks and the overlay. */
  box: { x: number; y: number; w: number; h: number };
  frameId: number;
  disabled?: boolean;
  checked?: boolean;
}

export interface MediaState {
  present: boolean;
  playing: boolean;
  muted: boolean;
  currentTime: number;
  duration: number;
  rate: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  pageType: PageType;
  elements: IndexedElement[];
  media?: MediaState;
  /** Frame that owns `media`. Course players are usually in an iframe. */
  mediaFrameId?: number;
  /** Trimmed visible text, used for instruction capture and reading lessons. */
  textDigest: string;
  scroll: { y: number; height: number };
  at: number;
}
