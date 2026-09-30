import { describe, expect, it } from "vitest";
import { normalizeStep } from "./executor";

/**
 * The executor's validator is the boundary between model output and real browser
 * actions, so it has to be strict about malformed input and forgiving about the
 * harmless variation models produce.
 */
describe("normalizeStep", () => {
  const base = {
    evaluation_previous_step: "clicked Next, lesson loaded",
    memory: "Module 2: 3/5 lessons done",
    next_goal: "play the lesson video",
  };

  it("accepts a well-formed step", () => {
    const step = normalizeStep({
      ...base,
      actions: [
        { type: "click", index: 15 },
        { type: "wait_until", condition: { type: "video_ended" }, timeoutMs: 600000 },
      ],
    });
    expect(step.actions).toHaveLength(2);
    expect(step.actions[0]).toEqual({ type: "click", index: 15 });
    expect(step.next_goal).toBe("play the lesson video");
  });

  it("drops unknown action types but keeps the valid ones", () => {
    const step = normalizeStep({
      ...base,
      actions: [{ type: "teleport", to: "moon" }, { type: "scroll", direction: "down" }],
    });
    expect(step.actions).toEqual([{ type: "scroll", direction: "down" }]);
  });

  it("coerces index and timeout values models often send as strings", () => {
    const step = normalizeStep({
      ...base,
      actions: [{ type: "type", index: "7", text: "hello" }],
    });
    expect(step.actions[0]).toMatchObject({ type: "type", index: 7, text: "hello" });
  });

  it("rejects a navigate that is not http(s), so the agent cannot be steered to a file or script URL", () => {
    expect(() =>
      normalizeStep({ ...base, actions: [{ type: "navigate", url: "javascript:alert(1)" }] }),
    ).toThrow(/no usable actions/);
  });

  it("caps an oversized wait so a bad timeout cannot strand a task", () => {
    const step = normalizeStep({
      ...base,
      actions: [
        { type: "wait_until", condition: { type: "video_ended" }, timeoutMs: 999_999_999 },
      ],
    });
    expect(step.actions[0]).toMatchObject({ timeoutMs: 30 * 60_000 });
  });

  it("throws when no action survives validation, rather than returning an empty step", () => {
    expect(() => normalizeStep({ ...base, actions: [{ type: "click" }] })).toThrow(
      /no usable actions/,
    );
    expect(() => normalizeStep({ ...base, actions: [] })).toThrow(/no usable actions/);
  });

  it("defaults a remember action's kind and scope instead of failing on them", () => {
    const step = normalizeStep({
      ...base,
      actions: [{ type: "remember", text: "quiz needs 80% to pass", kind: "bogus", pin: true }],
    });
    expect(step.actions[0]).toEqual({
      type: "remember",
      kind: "note",
      scope: "task",
      text: "quiz needs 80% to pass",
      pin: true,
    });
  });

  it("keeps ask_human options and clamps them to a usable number", () => {
    const step = normalizeStep({
      ...base,
      actions: [
        {
          type: "ask_human",
          kind: "confirm",
          question: "Submit the quiz?",
          options: ["a", "b", "c", "d", "e", "f", "g", "h"],
        },
      ],
    });
    expect(step.actions[0]).toMatchObject({ kind: "confirm" });
    const action = step.actions[0] as { options: string[] };
    expect(action.options).toHaveLength(6);
  });

  it("truncates a batch to six actions", () => {
    const step = normalizeStep({
      ...base,
      actions: Array.from({ length: 12 }, (_, i) => ({ type: "click", index: i })),
    });
    expect(step.actions).toHaveLength(6);
  });


  it("accepts every real media op and rejects an invented one", () => {
    for (const op of ["play", "pause", "unmute", "captions", "seek_end"]) {
      const step = normalizeStep({ ...base, actions: [{ type: "media", op }] });
      expect(step.actions[0]).toEqual({ type: "media", op });
    }

    expect(() =>
      normalizeStep({ ...base, actions: [{ type: "media", op: "fullscreen" }] }),
    ).toThrow(/no usable actions/);
  });

  it("defaults a rate op that forgot its rate, instead of dropping the action", () => {
    const step = normalizeStep({ ...base, actions: [{ type: "media", op: "rate" }] });
    expect(step.actions[0]).toEqual({ type: "media", op: "rate", rate: 1 });
  });

  it("clamps a video stall window to something that will not trip on buffering", () => {
    const tooShort = normalizeStep({
      ...base,
      actions: [
        { type: "wait_until", condition: { type: "video_ended", stallSeconds: 1 }, timeoutMs: 60000 },
      ],
    });
    expect(tooShort.actions[0]).toMatchObject({
      condition: { type: "video_ended", stallSeconds: 10 },
    });

    const tooLong = normalizeStep({
      ...base,
      actions: [
        { type: "wait_until", condition: { type: "video_ended", stallSeconds: 9999 }, timeoutMs: 60000 },
      ],
    });
    expect(tooLong.actions[0]).toMatchObject({
      condition: { type: "video_ended", stallSeconds: 600 },
    });
  });

  it("leaves stallSeconds unset when the model does not ask for one, so policy decides", () => {
    const step = normalizeStep({
      ...base,
      actions: [{ type: "wait_until", condition: { type: "video_ended" }, timeoutMs: 60000 }],
    });
    expect(step.actions[0]).toEqual({
      type: "wait_until",
      condition: { type: "video_ended" },
      timeoutMs: 60000,
    });
  });

  it("rejects a non-object reply", () => {
    expect(() => normalizeStep("done!")).toThrow(/not an object/);
  });
});
