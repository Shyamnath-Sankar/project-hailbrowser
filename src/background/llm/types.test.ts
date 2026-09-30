import { describe, expect, it } from "vitest";
import { costUsd, extractJson, isTransient, isUnpriced, priceFor, withRetry } from "./types";

describe("isTransient", () => {
  it("retries the status codes that mean try again", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isTransient(Object.assign(new Error("boom"), { status }))).toBe(true);
    }
  });

  it("does not retry a client error the request itself caused", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isTransient(Object.assign(new Error("bad request"), { status }))).toBe(false);
    }
  });

  it("recognizes a status embedded in a provider's error text", () => {
    expect(isTransient(new Error("openai 503: upstream unavailable"))).toBe(true);
    expect(isTransient(new Error("gemini 429: quota exceeded"))).toBe(true);
  });

  it("does not mistake a number inside a message for a status code", () => {
    // The old word-boundary bug read the 500 in "5000" as a server error.
    expect(isTransient(new Error("max_tokens must be under 5000 for this model"))).toBe(false);
    expect(isTransient(new Error("prompt is 4292 tokens too long"))).toBe(false);
  });

  it("recognizes transient phrasing without a status code", () => {
    expect(isTransient(new Error("fetch failed"))).toBe(true);
    expect(isTransient(new Error("Overloaded"))).toBe(true);
    expect(isTransient(new Error("socket hang up"))).toBe(true);
    expect(isTransient(new Error("invalid api key"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the result once a transient failure clears", async () => {
    let calls = 0;
    const result = await withRetry("test", async () => {
      calls++;
      if (calls < 2) throw Object.assign(new Error("rate limit"), { status: 429 });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("gives up immediately on an error retrying cannot fix", async () => {
    let calls = 0;
    await expect(
      withRetry("test", async () => {
        calls++;
        throw Object.assign(new Error("invalid key"), { status: 401 });
      }),
    ).rejects.toThrow(/invalid key/);
    // A bad key will still be bad in two seconds, so it must not be retried.
    expect(calls).toBe(1);
  });

  it("names the provider and the attempts it actually made", async () => {
    await expect(
      withRetry(
        "openai (executor)",
        async () => {
          throw Object.assign(new Error("boom"), { status: 503 });
        },
        2,
      ),
    ).rejects.toThrow(/openai \(executor\) failed after 2 attempts/);
  });

  it("does not claim retries it never made", async () => {
    // The old message always printed the ceiling, so a first-try failure read as
    // "failed after 3 attempts" and sent you hunting a flaky endpoint.
    await expect(
      withRetry(
        "custom (planner)",
        async () => {
          throw new Error("empty response");
        },
        3,
      ),
    ).rejects.toThrow(/^custom \(planner\) failed: empty response/);
  });
});

describe("pricing", () => {
  it("prices a known model, including a vendor-prefixed id", () => {
    expect(priceFor("claude-sonnet-5-5").in).toBe(2);
    expect(priceFor("anthropic/claude-sonnet-5-5").out).toBe(10);
    expect(costUsd("claude-haiku-4-5", 1_000_000, 1_000_000)).toBeCloseTo(6);
  });

  it("reports zero for a model it cannot price, rather than guessing", () => {
    // A custom endpoint's spend is unknowable, and a fabricated number in the
    // budget meter is worse than an empty one.
    expect(isUnpriced("some-local-model")).toBe(true);
    expect(costUsd("some-local-model", 500_000, 500_000)).toBe(0);
  });
});

describe("extractJson", () => {
  it("pulls the object out of a fenced or prefaced reply", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Here you go: {"a":1} — hope that helps')).toBe('{"a":1}');
  });

  it("keeps nested braces and braces inside strings intact", () => {
    const json = '{"a":{"b":2},"c":"}{ not real"}';
    expect(extractJson(`noise ${json} more`)).toBe(json);
  });
});
