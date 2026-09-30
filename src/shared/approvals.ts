import type { ApprovalGrant } from "./types";

/**
 * Stable identity for a gated action, used to remember the human's decision.
 *
 * Deliberately not the element index: indexes are reassigned on every snapshot,
 * so an index-keyed grant would never match on the step that follows and the gate
 * would ask the same question forever. A label plus host survives a re-render.
 */
export function approvalKey(kind: string, label: string, url: string): string {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  const normalized = label.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60);
  return `${kind}:${normalized}:${host}`;
}

/** Wording that means the human already performed the action themselves. */
const HANDLED =
  /\b(i (handled|did|already|clicked|sent|typed)|handled it|already (done|sent|clicked|handled))\b/;

/** Wording that means stop asking about this action for the rest of the task. */
const ALWAYS = /\b(stop asking|don'?t ask|do not ask|always|every ?time|no need to ask)\b/;

/** Wording that declines the action. Anchored, so "not now" counts but "cannot" does not. */
const DECLINE = /^(n|no|nope|nah|don'?t|do not|skip|deny|refuse|cancel that|not now)\b/;

/**
 * Reads the human's reply to a gated action into a durable decision.
 *
 * Order matters. "I handled it, don't ask again" is a human who did the work
 * themselves, so that reading has to win over the "don't ask" one - otherwise the
 * agent is cleared to repeat an action that already happened.
 */
export function grantFrom(reply: string, now = Date.now()): ApprovalGrant {
  const text = reply.trim().toLowerCase();

  if (HANDLED.test(text)) {
    return {
      mode: "denied",
      at: now,
      note: "The human performed this action themselves. Treat it as already done, verify the result on the page, and carry on - do not repeat it.",
    };
  }

  if (ALWAYS.test(text)) return { mode: "always", at: now };

  if (DECLINE.test(text)) {
    return {
      mode: "denied",
      at: now,
      note: "The human declined this action. Do not attempt it again. Find another route, or ask what to do instead.",
    };
  }

  // Anything else reads as plain assent, and is spent on the next matching action.
  return { mode: "once", at: now };
}
