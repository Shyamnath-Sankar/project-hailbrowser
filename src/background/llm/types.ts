import type { AgentRole } from "../../shared/types";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
  /** PNG data URL. Only sent when the caller asked for vision. */
  imageDataUrl?: string;
}

export interface LlmRequest {
  role: AgentRole;
  system: string;
  messages: LlmMessage[];
  /** JSON Schema the reply must satisfy. Providers fall back to prompt-only JSON. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** Set when the provider declined the request rather than answering it. */
  refusal?: string;
}

/** USD per million tokens, used for the in-task budget meter. */
export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export function priceFor(model: string): { in: number; out: number } {
  // Match the longest known id contained in the model string, so a dated or
  // vendor-prefixed name ("anthropic/claude-sonnet-5-5") still prices.
  const key = Object.keys(PRICES)
    .filter((k) => model.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? PRICES[key]! : { in: 0, out: 0 };
}

/**
 * Cost of one call. An unknown model prices at zero rather than at a guess: a
 * made-up number in the budget meter is worse than an obviously empty one, and
 * the step and time budgets still bound the task either way.
 */
export function costUsd(model: string, inTok: number, outTok: number): number {
  const p = priceFor(model);
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

/** True when no price is known for this model, so the $ meter stays at zero. */
export function isUnpriced(model: string): boolean {
  const p = priceFor(model);
  return p.in === 0 && p.out === 0;
}

/** Phrases that mean "try again", matched case-insensitively as substrings. */
const TRANSIENT_PHRASES = [
  "timeout",
  "timed out",
  "econnreset",
  "socket hang up",
  "network",
  "fetch failed",
  "overloaded",
  "rate limit",
  "too many requests",
  "try again",
  "temporarily unavailable",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "internal server error",
];

/** HTTP statuses worth retrying. */
const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

export function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") {
    return TRANSIENT_STATUS.has(status) || status >= 500;
  }
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (TRANSIENT_PHRASES.some((phrase) => text.includes(phrase))) return true;
  // A bare status code in the message, e.g. `openai 503: upstream error`. The
  // code must be delimited so a token count like "5000" does not read as a 500.
  return [...TRANSIENT_STATUS].some((code) => new RegExp(`(^|[^0-9])${code}([^0-9]|$)`).test(text));
}

/**
 * Retries transient API failures. A task running for hours will meet a 429 or a
 * 503 eventually, and losing that work to a blip that clears in two seconds is
 * the worst failure mode this agent has.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  let made = 0;
  for (let i = 0; i < attempts; i++) {
    made++;
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransient(err) || i === attempts - 1) break;
      // 1s, 2s, 4s plus jitter, so concurrent callers do not retry in lockstep.
      const delay = 1000 * 2 ** i + Math.random() * 400;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Report attempts actually made, not the ceiling. Saying "failed after 3
  // attempts" when a non-transient error stopped it at the first one sends
  // anyone debugging it looking for a flaky endpoint instead of the real cause.
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    made > 1 ? `${label} failed after ${made} attempts: ${detail}` : `${label} failed: ${detail}`,
  );
}

/** Pulls the first JSON object out of a reply that may be fenced or prefaced. */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start === -1) return body.trim();
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return body.slice(start, i + 1);
  }
  return body.slice(start).trim();
}
