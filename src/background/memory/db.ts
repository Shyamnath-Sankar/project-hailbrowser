import Dexie, { type Table } from "dexie";
import type {
  Checkpoint,
  Memory,
  PlanNode,
  StepRecord,
  Task,
} from "../../shared/types";

export interface ChatRow {
  id: string;
  taskId: string;
  role: "user" | "agent" | "system";
  text: string;
  at: number;
  /** Set once the executor has folded this message into its instructions. */
  consumed?: boolean;
}

export interface SkillRow {
  name: string;
  /** Free-form matcher: page types and/or URL substrings. */
  pageTypes: string[];
  hosts: string[];
  description: string;
  body: string;
  builtin: boolean;
}

class AgentDb extends Dexie {
  tasks!: Table<Task, string>;
  plan!: Table<PlanNode, string>;
  steps!: Table<StepRecord, string>;
  memories!: Table<Memory, string>;
  checkpoints!: Table<Checkpoint, string>;
  chat!: Table<ChatRow, string>;
  skills!: Table<SkillRow, string>;

  constructor() {
    super("project-browser");
    this.version(1).stores({
      tasks: "id, status, updatedAt",
      plan: "id, taskId, parentId, status, [taskId+order]",
      steps: "id, taskId, [taskId+index]",
      memories: "id, taskId, kind, scope, scopeKey, pinned, [scope+scopeKey]",
      checkpoints: "taskId",
      chat: "id, taskId, at, [taskId+consumed]",
      skills: "name, builtin",
    });
  }
}

export const db = new AgentDb();

export const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
