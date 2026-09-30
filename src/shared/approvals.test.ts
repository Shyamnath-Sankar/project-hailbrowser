import { describe, expect, it } from "vitest";
import { approvalKey, grantFrom } from "./approvals";

/**
 * These pin down the confirm loop that shipped broken: the gate asked, the human
 * said yes, nothing recorded the decision, and the next step asked again.
 */
describe("approvalKey", () => {
  it("is stable across snapshots, because element indexes are not", () => {
    // The loop's root cause would return if this key included the index: indexes
    // are reassigned on every snapshot, so no grant would ever match again.
    const a = approvalKey("click", "Send prompt", "https://chatgpt.com/c/abc");
    const b = approvalKey("click", "Send prompt", "https://chatgpt.com/c/xyz");
    expect(a).toBe(b);
  });

  it("ignores case and whitespace noise in the label", () => {
    expect(approvalKey("click", "  Send   Prompt ", "https://a.test/")).toBe(
      approvalKey("click", "send prompt", "https://a.test/"),
    );
  });

  it("separates different actions, labels and sites", () => {
    const base = approvalKey("click", "Send", "https://a.test/");
    expect(base).not.toBe(approvalKey("submit", "Send", "https://a.test/"));
    expect(base).not.toBe(approvalKey("click", "Delete", "https://a.test/"));
    expect(base).not.toBe(approvalKey("click", "Send", "https://b.test/"));
  });

  it("does not throw on a url the browser gave us that URL cannot parse", () => {
    expect(() => approvalKey("click", "Send", "about:blank#weird")).not.toThrow();
  });
});

describe("grantFrom", () => {
  it("treats plain assent as a one-shot grant", () => {
    for (const reply of ["Yes, click it", "yes", "sure, go ahead", "ok"]) {
      expect(grantFrom(reply).mode).toBe("once");
    }
  });

  it("records a standing grant when asked to stop asking", () => {
    for (const reply of ["Yes, and stop asking", "always", "don't ask again", "no need to ask"]) {
      expect(grantFrom(reply).mode).toBe("always");
    }
  });

  it("declines without cancelling, and explains why to the model", () => {
    const grant = grantFrom("No, skip it");
    expect(grant.mode).toBe("denied");
    // A bare failure would invite a retry; the note is what stops the loop.
    expect(grant.note).toMatch(/declined/i);
  });

  it("reads 'I handled it' as already done, not as permission to redo it", () => {
    // The panel button used to send "done, continue", which parsed as assent - so
    // the agent re-sent a message the human had just sent by hand.
    const grant = grantFrom("I handled it myself, continue");
    expect(grant.mode).toBe("denied");
    expect(grant.note).toMatch(/already done/i);
  });

  it("prefers 'already handled' over 'stop asking' when a reply says both", () => {
    // Ordering matters: the other reading would clear the agent to repeat an
    // action that has already happened.
    const grant = grantFrom("I already sent it, don't ask again");
    expect(grant.mode).toBe("denied");
    expect(grant.note).toMatch(/already done/i);
  });

  it("does not read a word merely containing 'no' as a refusal", () => {
    expect(grantFrom("now click it").mode).toBe("once");
    expect(grantFrom("Yes - I cannot do it myself").mode).toBe("once");
  });

  it("handles the panel's own option labels", () => {
    expect(grantFrom("Yes, click it").mode).toBe("once");
    expect(grantFrom("Yes, and stop asking").mode).toBe("always");
    expect(grantFrom("No, do not send").mode).toBe("denied");
  });
});
