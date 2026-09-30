import { db, newId, type ChatRow } from "./db";
import type {
  Checkpoint,
  Memory,
  MemoryKind,
  MemoryScope,
  MemorySource,
  NodeStatus,
  PlanNode,
  StepRecord,
  Task,
  TaskStatus,
} from "../../shared/types";

/* ---------------------------------- tasks ---------------------------------- */

export async function createTask(goal: string, tabId?: number): Promise<Task> {
  const now = Date.now();
  const task: Task = {
    id: newId("task"),
    goal,
    status: "planning",
    createdAt: now,
    updatedAt: now,
    tabId,
    stepCount: 0,
    usdSpent: 0,
  };
  await db.tasks.add(task);
  return task;
}

export async function patchTask(id: string, patch: Partial<Task>): Promise<Task | undefined> {
  await db.tasks.update(id, { ...patch, updatedAt: Date.now() });
  return db.tasks.get(id);
}

export const getTask = (id: string): Promise<Task | undefined> => db.tasks.get(id);

export const listTasks = (): Promise<Task[]> =>
  db.tasks.orderBy("updatedAt").reverse().limit(50).toArray();

/** Tasks that were mid-flight when the worker died and should be picked back up. */
export async function resumableTasks(): Promise<Task[]> {
  const live: TaskStatus[] = ["planning", "running"];
  return db.tasks.where("status").anyOf(live).toArray();
}

/* ----------------------------------- plan ---------------------------------- */

export async function replacePlan(
  taskId: string,
  nodes: Array<Omit<PlanNode, "id" | "taskId">>,
): Promise<PlanNode[]> {
  await db.plan.where("taskId").equals(taskId).delete();
  const rows: PlanNode[] = nodes.map((n) => ({ ...n, id: newId("node"), taskId }));
  await db.plan.bulkAdd(rows);
  return rows;
}

export const getPlan = (taskId: string): Promise<PlanNode[]> =>
  db.plan.where("taskId").equals(taskId).sortBy("order");

export async function setNodeStatus(
  nodeId: string,
  status: NodeStatus,
  note?: string,
): Promise<void> {
  await db.plan.update(nodeId, note === undefined ? { status } : { status, note });
}

/** First leaf that still needs doing, in plan order. */
export async function nextPendingNode(taskId: string): Promise<PlanNode | undefined> {
  const nodes = await getPlan(taskId);
  const hasChildren = new Set(nodes.map((n) => n.parentId).filter(Boolean) as string[]);
  return nodes.find(
    (n) => !hasChildren.has(n.id) && (n.status === "todo" || n.status === "active"),
  );
}

/* ---------------------------------- steps ---------------------------------- */

export async function addStep(step: Omit<StepRecord, "id">): Promise<StepRecord> {
  const row: StepRecord = { ...step, id: newId("step") };
  await db.steps.add(row);
  return row;
}

export const recentSteps = async (taskId: string, n: number): Promise<StepRecord[]> => {
  const rows = await db.steps.where("taskId").equals(taskId).reverse().sortBy("index");
  return rows.slice(0, n).reverse();
};

/* -------------------------------- checkpoints ------------------------------- */

export const saveCheckpoint = (cp: Checkpoint): Promise<string> => db.checkpoints.put(cp);
export const loadCheckpoint = (taskId: string): Promise<Checkpoint | undefined> =>
  db.checkpoints.get(taskId);

/* --------------------------------- memories -------------------------------- */

export async function remember(input: {
  taskId: string | null;
  kind: MemoryKind;
  scope: MemoryScope;
  scopeKey: string;
  text: string;
  source: MemorySource;
  pinned?: boolean;
  url?: string;
}): Promise<Memory> {
  const row: Memory = {
    id: newId("mem"),
    taskId: input.taskId,
    kind: input.kind,
    scope: input.scope,
    scopeKey: input.scopeKey,
    text: input.text.slice(0, 4000),
    source: input.source,
    pinned: input.pinned ?? false,
    createdAt: Date.now(),
    url: input.url,
  };
  await db.memories.add(row);
  return row;
}

/** Everything pinned for the scopes in play, newest last. */
export async function pinnedFor(scopeKeys: string[]): Promise<Memory[]> {
  const rows = await db.memories.where("scopeKey").anyOf(scopeKeys).toArray();
  return rows.filter((m) => m.pinned).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Keyword recall. Deliberately simple: scores overlap of query terms against
 * the memory text, with a bonus for the scopes currently in play.
 */
export async function recall(
  query: string,
  scopeKeys: string[],
  limit = 8,
): Promise<Memory[]> {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  const rows = await db.memories.toArray();
  const scored = rows.map((m) => {
    const text = m.text.toLowerCase();
    const matches = terms.reduce((sum, t) => (text.includes(t) ? sum + 1 : sum), 0);
    // Scope and pin are tie-breakers on something that already matched. Letting
    // them score on their own would make recall return every in-scope memory
    // regardless of the query.
    if (matches === 0) return { m, score: 0 };
    let score = matches;
    if (scopeKeys.includes(m.scopeKey)) score += 1.5;
    if (m.pinned) score += 1;
    return { m, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt)
    .slice(0, limit)
    .map((s) => s.m);
}

export const listMemories = (taskId: string | null): Promise<Memory[]> =>
  taskId
    ? db.memories.where("taskId").equals(taskId).reverse().sortBy("createdAt")
    : db.memories.reverse().sortBy("createdAt");

export const forgetMemory = (id: string): Promise<void> => db.memories.delete(id);

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  await db.memories.update(id, { pinned });
}

/* ----------------------------------- chat ---------------------------------- */

export async function addChat(
  taskId: string,
  role: ChatRow["role"],
  text: string,
): Promise<ChatRow> {
  const row: ChatRow = { id: newId("chat"), taskId, role, text, at: Date.now() };
  await db.chat.add(row);
  return row;
}

export const chatFor = (taskId: string): Promise<ChatRow[]> =>
  db.chat.where("taskId").equals(taskId).sortBy("at");

/** User messages the executor has not yet folded into its instructions. */
export async function unconsumedUserChat(taskId: string): Promise<ChatRow[]> {
  const rows = await db.chat.where("taskId").equals(taskId).sortBy("at");
  return rows.filter((r) => r.role === "user" && !r.consumed);
}

export async function markChatConsumed(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => db.chat.update(id, { consumed: true })));
}
