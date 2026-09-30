import type { NodeStatus, PageSnapshot, PlanNode, Settings, Task } from "../../shared/types";
import { callModel } from "../llm";
import { db, newId } from "../memory/db";

/**
 * The planner runs rarely: once to build the tree, then only when the executor
 * is stuck or the shape of the work turns out to be different than expected.
 */

const PLANNER_SYSTEM = [
  "You are the planner for a long-horizon browser agent. You turn a user goal into a plan tree, then repair that tree when reality differs.",
  "",
  "Rules:",
  "- Leaves are single units of work the executor can finish in a handful of browser actions: one lesson, one video, one form, one quiz.",
  "- Group leaves under parents (modules, sections, phases) when the work has that structure. Depth of 2 is usually right, 3 at most.",
  "- Order matters: emit nodes in the order they must be done. Respect stated prerequisites over display order.",
  "- Mark a leaf graded: true when finishing it produces a score - quizzes, exams, graded assignments.",
  "- If the page you are shown is an index or syllabus, use it. If you do not yet know the full structure, emit a first node that navigates and reads the index, then a placeholder parent to expand later.",
  "- Do not invent lesson names you have not seen. An honest placeholder beats a fabricated list.",
  "- Keep titles short and specific: 'Module 2 - Lesson 3: Cell division (video)'.",
  "",
  "Return only JSON: { nodes: [ { key, parentKey, title, graded? } ] } where key is a short unique string you choose and parentKey is null for a top-level node.",
].join("\n");

const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["nodes"],
  properties: {
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "parentKey", "title"],
        properties: {
          key: { type: "string" },
          parentKey: { type: ["string", "null"] },
          title: { type: "string" },
          graded: { type: "boolean" },
        },
      },
    },
  },
};

interface PlannedNode {
  key: string;
  parentKey: string | null;
  title: string;
  graded?: boolean;
}

export interface PlanResult {
  nodes: PlanNode[];
  usd: number;
}

/** Builds (or rebuilds) the plan tree and persists it. */
export async function makePlan(
  settings: Settings,
  task: Task,
  snapshot: PageSnapshot | undefined,
  context: { existing: PlanNode[]; reason: string; notes: string[] },
): Promise<PlanResult> {
  const parts: string[] = [`# Goal\n${task.goal}`, `# Why you are planning now\n${context.reason}`];

  if (context.existing.length) {
    parts.push(
      [
        "# Existing plan (preserve what is already done)",
        ...context.existing.map(
          (n) => `${n.status === "done" ? "[x]" : n.status === "skipped" ? "[-]" : "[ ]"} ${n.title}`,
        ),
      ].join("\n"),
    );
  }

  if (context.notes.length) {
    parts.push(`# What the executor has learned\n${context.notes.map((n) => `- ${n}`).join("\n")}`);
  }

  if (snapshot) {
    parts.push(
      [
        "# Current page",
        `url: ${snapshot.url}`,
        `title: ${snapshot.title}`,
        `page type: ${snapshot.pageType}`,
        "",
        "Links and controls:",
        snapshot.elements
          .slice(0, 120)
          .map((el) => `[${el.index}] ${el.tag} ${JSON.stringify(el.label)}`)
          .join("\n"),
        "",
        "Visible text:",
        snapshot.textDigest.slice(0, 5000),
      ].join("\n"),
    );
  }

  const res = await callModel(settings, "planner", {
    system: PLANNER_SYSTEM,
    messages: [{ role: "user", content: parts.join("\n\n") }],
    schema: PLAN_SCHEMA,
    maxTokens: 16000,
  });

  if (res.refusal) throw new Error(`Planner declined: ${res.refusal}`);

  const parsed = JSON.parse(res.text) as { nodes?: PlannedNode[] };
  const planned = parsed.nodes ?? [];
  if (!planned.length) throw new Error("Planner returned an empty plan");

  // Carry forward completed work: a node whose title matches an existing done
  // node keeps that status, so a replan never redoes finished lessons.
  const doneTitles = new Map(
    context.existing
      .filter((n) => n.status === "done" || n.status === "skipped")
      .map((n) => [normalize(n.title), n.status]),
  );

  // Assign real ids first so parent links can be resolved in a single write.
  const idByKey = new Map<string, string>();
  for (const n of planned) {
    if (!idByKey.has(n.key)) idByKey.set(n.key, newId("node"));
  }

  const rows: PlanNode[] = planned.map((n, i) => {
    const id = idByKey.get(n.key)!;
    const parentId = n.parentKey ? (idByKey.get(n.parentKey) ?? null) : null;
    const status: NodeStatus = doneTitles.get(normalize(n.title)) ?? "todo";
    return {
      id,
      taskId: task.id,
      // A node naming itself as parent, or an unknown key, becomes top-level.
      parentId: parentId === id ? null : parentId,
      title: n.title.slice(0, 200),
      status,
      order: i,
      graded: n.graded ?? false,
    };
  });

  await writePlan(task.id, rows);
  return { nodes: rows, usd: res.usd };
}

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

async function writePlan(taskId: string, nodes: PlanNode[]): Promise<void> {
  await db.transaction("rw", db.plan, async () => {
    await db.plan.where("taskId").equals(taskId).delete();
    await db.plan.bulkAdd(nodes);
  });
}
