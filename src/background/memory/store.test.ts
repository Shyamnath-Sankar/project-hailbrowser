import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import {
  createTask,
  nextPendingNode,
  pinnedFor,
  recall,
  remember,
  replacePlan,
  setNodeStatus,
} from "./store";

/**
 * Memory is what makes long tasks work: rules captured on one page have to still
 * be in context many steps later, and notes have to come back on demand.
 */
describe("memory store", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("keeps pinned instructions retrievable by scope, which is how test rules survive to the test", async () => {
    const task = await createTask("finish the statistics course");

    await remember({
      taskId: task.id,
      kind: "instruction",
      scope: "course",
      scopeKey: "course:example.edu",
      text: "Quiz 2: 10 questions, 80% to pass, 3 attempts, no going back after submitting.",
      source: "page",
      pinned: true,
    });
    // An unpinned note in the same scope must not crowd the prompt.
    await remember({
      taskId: task.id,
      kind: "note",
      scope: "course",
      scopeKey: "course:example.edu",
      text: "Lesson 3 covered standard deviation.",
      source: "agent",
    });
    // A pinned memory from a different course must not leak in.
    await remember({
      taskId: task.id,
      kind: "instruction",
      scope: "course",
      scopeKey: "course:other.edu",
      text: "Unrelated course rule.",
      source: "page",
      pinned: true,
    });

    const pinned = await pinnedFor(["course:example.edu", task.id]);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.text).toContain("80% to pass");
  });

  it("recalls notes by keyword and ranks the in-scope ones first", async () => {
    const task = await createTask("course");
    await remember({
      taskId: task.id,
      kind: "note",
      scope: "course",
      scopeKey: "course:a",
      text: "Photosynthesis converts light into chemical energy in chloroplasts.",
      source: "agent",
    });
    await remember({
      taskId: task.id,
      kind: "note",
      scope: "course",
      scopeKey: "course:b",
      text: "Photosynthesis appears in an unrelated course.",
      source: "agent",
    });
    await remember({
      taskId: task.id,
      kind: "note",
      scope: "course",
      scopeKey: "course:a",
      text: "Mitosis has four phases.",
      source: "agent",
    });

    const hits = await recall("photosynthesis chloroplasts", ["course:a"]);
    expect(hits[0]?.text).toContain("chloroplasts");
    expect(hits.some((h) => h.text.includes("Mitosis"))).toBe(false);
  });

  it("returns nothing rather than guessing when recall has no match", async () => {
    const task = await createTask("course");
    await remember({
      taskId: task.id,
      kind: "note",
      scope: "task",
      scopeKey: task.id,
      text: "Only note.",
      source: "agent",
    });
    expect(await recall("quantum chromodynamics", [task.id])).toEqual([]);
  });

  it("walks plan leaves in order and skips finished ones, so a resumed task does not redo work", async () => {
    const task = await createTask("course");
    const nodes = await replacePlan(task.id, [
      { parentId: null, title: "Module 1", status: "todo", order: 0 },
      { parentId: null, title: "Lesson 1.1", status: "done", order: 1 },
      { parentId: null, title: "Lesson 1.2", status: "todo", order: 2 },
      { parentId: null, title: "Quiz 1", status: "todo", order: 3, graded: true },
    ]);
    expect(nodes).toHaveLength(4);
    // Hang the lessons under the module, the shape the planner produces.
    const moduleId = nodes[0]!.id;
    for (const child of nodes.slice(1)) {
      await db.plan.update(child.id, { parentId: moduleId });
    }

    const first = await nextPendingNode(task.id);
    expect(first?.title).toBe("Lesson 1.2");

    await setNodeStatus(first!.id, "done");
    const second = await nextPendingNode(task.id);
    expect(second?.title).toBe("Quiz 1");
    expect(second?.graded).toBe(true);
  });

  it("treats a parent with children as structure, not as work to do", async () => {
    const task = await createTask("course");
    const nodes = await replacePlan(task.id, [
      { parentId: null, title: "Module 1", status: "todo", order: 0 },
      { parentId: "PLACEHOLDER", title: "Lesson 1.1", status: "todo", order: 1 },
    ]);
    // Re-point the child at the real parent id, as the planner does.
    await db.plan.update(nodes[1]!.id, { parentId: nodes[0]!.id });

    const next = await nextPendingNode(task.id);
    expect(next?.title).toBe("Lesson 1.1");
  });
});
