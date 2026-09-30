import { afterEach, describe, expect, it, vi } from "vitest";
import { callOpenAiCompat } from "./openai-compat";
import type { LlmRequest } from "./types";

/**
 * "OpenAI-compatible" is a spectrum. These tests pin the negotiation that lets a
 * server which only implements part of the API still drive the agent, because the
 * failure it replaces was a hard stop: a planner that returned empty on every
 * step while a plain-text test call looked fine.
 */

const SCHEMA_REQ: LlmRequest = {
  role: "planner",
  system: "Reply with JSON.",
  messages: [{ role: "user", content: "go" }],
  schema: { type: "object", properties: { a: { type: "string" } } },
};

interface Reply {
  content?: string | null;
  reasoning_content?: string;
  finish_reason?: string;
  status?: number;
  body?: string;
}

/** Queues one HTTP reply per call and records the bodies we sent. */
function mockFetch(replies: Reply[]): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    if (reply.status && reply.status >= 400) {
      return {
        ok: false,
        status: reply.status,
        text: async () => reply.body ?? "rejected",
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: reply.content ?? "",
              reasoning_content: reply.reasoning_content,
            },
            finish_reason: reply.finish_reason,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    };
  });
  return { bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JSON mode negotiation", () => {
  it("uses json_schema when the server honours it, and asks only once", async () => {
    const { bodies } = mockFetch([{ content: '{"a":"1"}' }]);
    const res = await callOpenAiCompat(SCHEMA_REQ, "m", "k", "https://a.test/v1", undefined, "custom");

    expect(res.text).toBe('{"a":"1"}');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.response_format).toMatchObject({ type: "json_schema" });
  });

  it("falls back to json_object when json_schema returns empty content", async () => {
    // The reported failure: the server accepts response_format json_schema, then
    // answers with nothing at all.
    const { bodies } = mockFetch([{ content: "" }, { content: '{"a":"2"}' }]);
    const res = await callOpenAiCompat(SCHEMA_REQ, "m", "k", "https://b.test/v1", undefined, "custom");

    expect(res.text).toBe('{"a":"2"}');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.response_format).toEqual({ type: "json_object" });
  });

  it("falls back all the way to a prompt-only request", async () => {
    const { bodies } = mockFetch([
      { content: "" },
      { content: "" },
      { content: 'Sure:\n```json\n{"a":"3"}\n```' },
    ]);
    const res = await callOpenAiCompat(SCHEMA_REQ, "m", "k", "https://c.test/v1", undefined, "custom");

    // The fenced reply is unwrapped, so a server with no JSON mode still works.
    expect(res.text).toBe('{"a":"3"}');
    expect(bodies).toHaveLength(3);
    expect(bodies[2]!.response_format).toBeUndefined();
  });

  it("degrades when the server rejects response_format outright", async () => {
    const { bodies } = mockFetch([
      { status: 400, body: "unknown field response_format" },
      { content: '{"a":"4"}' },
    ]);
    const res = await callOpenAiCompat(SCHEMA_REQ, "m", "k", "https://d.test/v1", undefined, "custom");

    expect(res.text).toBe('{"a":"4"}');
    expect(bodies).toHaveLength(2);
  });

  it("remembers the working mode, so later steps do not re-probe", async () => {
    const { bodies } = mockFetch([{ content: "" }, { content: '{"a":"5"}' }]);
    const base = "https://e.test/v1";
    await callOpenAiCompat(SCHEMA_REQ, "m", "k", base, undefined, "custom");
    expect(bodies).toHaveLength(2);

    // Second call starts at json_object: one request, not two.
    await callOpenAiCompat(SCHEMA_REQ, "m", "k", base, undefined, "custom");
    expect(bodies).toHaveLength(3);
    expect(bodies[2]!.response_format).toEqual({ type: "json_object" });
  });

  it("does not retry modes when the model spent its budget on reasoning", async () => {
    // Retrying cannot fix this, and the message has to say so or the user goes
    // hunting the wrong problem.
    const { bodies } = mockFetch([{ content: "", reasoning_content: "thinking..." }]);
    await expect(
      callOpenAiCompat(SCHEMA_REQ, "m", "k", "https://f.test/v1", undefined, "custom"),
    ).rejects.toThrow(/reasoning/i);
    expect(bodies).toHaveLength(1);
  });

  it("reports a truncated reply as a token limit, not as an empty one", async () => {
    mockFetch([{ content: "", finish_reason: "length" }]);
    await expect(
      callOpenAiCompat(SCHEMA_REQ, "m", "k", "https://g.test/v1", undefined, "custom"),
    ).rejects.toThrow(/output limit/i);
  });
});

describe("request shape", () => {
  it("sends max_tokens to a custom server and max_completion_tokens to OpenAI", async () => {
    const custom = mockFetch([{ content: "hi" }]);
    await callOpenAiCompat(
      { ...SCHEMA_REQ, schema: undefined },
      "m",
      "k",
      "https://h.test/v1",
      undefined,
      "custom",
    );
    // Most compatible servers only understand the older name, and silently
    // truncate at a small default when the field they do not know is used.
    expect(custom.bodies[0]).toHaveProperty("max_tokens");
    expect(custom.bodies[0]).not.toHaveProperty("max_completion_tokens");

    vi.unstubAllGlobals();
    const openai = mockFetch([{ content: "hi" }]);
    await callOpenAiCompat(
      { ...SCHEMA_REQ, schema: undefined },
      "m",
      "k",
      undefined,
      undefined,
      "openai",
    );
    expect(openai.bodies[0]).toHaveProperty("max_completion_tokens");
  });

  it("accepts a base URL pasted with the full path or a trailing slash", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      };
    });

    const plain = { ...SCHEMA_REQ, schema: undefined };
    await callOpenAiCompat(plain, "m", "k", "https://i.test/v1/chat/completions", undefined, "custom");
    await callOpenAiCompat(plain, "m", "k", "https://i.test/v1///", undefined, "custom");

    expect(seen).toEqual([
      "https://i.test/v1/chat/completions",
      "https://i.test/v1/chat/completions",
    ]);
  });

  it("reads content from the array form some servers return", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: [{ type: "text", text: '{"a":"6"}' }] } }],
      }),
    }));
    const res = await callOpenAiCompat(SCHEMA_REQ, "m", "k", "https://j.test/v1", undefined, "custom");
    expect(res.text).toBe('{"a":"6"}');
  });
});
