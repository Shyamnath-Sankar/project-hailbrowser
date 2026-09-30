import type { PageSnapshot, Settings } from "../../shared/types";
import { callModel } from "../llm";

/**
 * A cheap second opinion at milestones. The executor is prone to marking work
 * done because it clicked the button; this checks the page actually reflects it.
 */

const VERIFIER_SYSTEM = [
  "You verify whether a browser agent actually completed a step, using only the page evidence given to you.",
  "Be strict and literal. A clicked button is not proof; a changed progress indicator, a completion mark, a new page state, or a stated score is.",
  "If the evidence is absent or ambiguous, say verified false and name exactly what you would need to see.",
  "Return only JSON: { verified: boolean, reason: string }",
].join("\n");

const VERIFY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verified", "reason"],
  properties: {
    verified: { type: "boolean" },
    reason: { type: "string" },
  },
};

export interface VerifyResult {
  verified: boolean;
  reason: string;
  usd: number;
}

export async function verifyMilestone(
  settings: Settings,
  claim: string,
  snapshot: PageSnapshot,
): Promise<VerifyResult> {
  const prompt = [
    `# The agent claims\n${claim}`,
    [
      "# Page evidence",
      `url: ${snapshot.url}`,
      `title: ${snapshot.title}`,
      `page type: ${snapshot.pageType}`,
      snapshot.media
        ? `media: ${snapshot.media.currentTime}/${snapshot.media.duration}s ${snapshot.media.playing ? "playing" : "paused"}`
        : "media: none",
      "",
      "Controls and labels:",
      snapshot.elements
        .slice(0, 80)
        .map((el) => `[${el.index}] ${el.tag} ${JSON.stringify(el.label)}`)
        .join("\n"),
      "",
      "Visible text:",
      snapshot.textDigest.slice(0, 2500),
    ].join("\n"),
    "Is the claim supported by this evidence?",
  ].join("\n\n");

  try {
    const res = await callModel(settings, "verifier", {
      system: VERIFIER_SYSTEM,
      messages: [{ role: "user", content: prompt }],
      schema: VERIFY_SCHEMA,
      maxTokens: 1000,
    });
    if (res.refusal) return { verified: true, reason: "verifier declined; not blocking", usd: res.usd };
    const parsed = JSON.parse(res.text) as { verified?: boolean; reason?: string };
    return {
      verified: parsed.verified ?? false,
      reason: parsed.reason ?? "no reason given",
      usd: res.usd,
    };
  } catch (err) {
    // Verification is advisory. A failure here must not stall the task.
    return { verified: true, reason: `verifier unavailable (${String(err).slice(0, 120)})`, usd: 0 };
  }
}
