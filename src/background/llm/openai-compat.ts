import { costUsd, extractJson, type LlmRequest, type LlmResponse } from "./types";

export type CompatFlavor = "openai" | "openrouter" | "ollama" | "custom";

const DEFAULT_BASE: Record<CompatFlavor, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
  // A custom endpoint has no sensible default; the caller validates this.
  custom: "",
};

/** How to ask for JSON, strongest first. We walk down this list on failure. */
type JsonMode = "json_schema" | "json_object" | "prompt_only";

const JSON_MODES: readonly JsonMode[] = ["json_schema", "json_object", "prompt_only"];

/**
 * Remembers which JSON mode actually worked for an endpoint, so the cost of
 * discovering it is paid once rather than on every step of a long task.
 */
const jsonModeCache = new Map<string, JsonMode>();

/**
 * Covers OpenAI, OpenRouter, Ollama, and anything else speaking the
 * /chat/completions shape - vLLM, LM Studio, llama.cpp, Together, Groq, Azure, a
 * corporate gateway.
 *
 * The awkward part is that "OpenAI-compatible" is a spectrum. Servers disagree on
 * the token-limit parameter, most do not implement `json_schema` response format,
 * and reasoning models put their answer in a different field. All three are
 * handled here rather than surfacing as an empty reply.
 */
export async function callOpenAiCompat(
  req: LlmRequest,
  model: string,
  key: string,
  baseUrl: string | undefined,
  _effort: string | undefined,
  flavor: CompatFlavor,
): Promise<LlmResponse> {
  const base = normalizeBase(baseUrl?.trim() || DEFAULT_BASE[flavor]);
  if (!base) throw new Error(`${flavor} needs a base URL`);

  const messages = [
    { role: "system" as const, content: req.system },
    ...req.messages.map((m) =>
      m.imageDataUrl
        ? {
            role: m.role,
            content: [
              { type: "image_url" as const, image_url: { url: m.imageDataUrl } },
              { type: "text" as const, text: m.content },
            ],
          }
        : { role: m.role, content: m.content },
    ),
  ];

  const headers: Record<string, string> = { "content-type": "application/json" };
  // A local Ollama, and some private gateways, need no key.
  if (key) {
    headers.authorization = `Bearer ${key}`;
    // Azure OpenAI deployments authenticate on this header instead.
    if (flavor === "custom" && /\.azure\.com/i.test(base)) headers["api-key"] = key;
  }
  if (flavor === "openrouter") headers["x-title"] = "Project Browser";

  const maxTokens = req.maxTokens ?? 8000;
  const cacheKey = `${base}|${model}`;

  // Plain-text requests need none of the JSON negotiation below.
  if (!req.schema) {
    const attempt = await once(base, headers, buildBody(model, messages, maxTokens, flavor, undefined, req.schema));
    if (!attempt.text.trim() && !attempt.refusal) throw emptyError(flavor, attempt);
    return toResponse(attempt, model, flavor, false);
  }

  // Start from whatever last worked for this endpoint, then degrade.
  const known = jsonModeCache.get(cacheKey);
  const modes = known ? JSON_MODES.slice(JSON_MODES.indexOf(known)) : JSON_MODES;

  const failures: string[] = [];

  for (const mode of modes) {
    let attempt: Attempt;
    try {
      attempt = await once(
        base,
        headers,
        buildBody(model, messages, maxTokens, flavor, mode, req.schema),
      );
    } catch (err) {
      // A 400 here usually means the server rejected the response_format field,
      // which is exactly the case the next mode fixes.
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${mode}: ${message}`);
      if (mode === "prompt_only") throw err;
      continue;
    }

    if (attempt.refusal) return toResponse(attempt, model, flavor, true);

    if (attempt.text.trim()) {
      jsonModeCache.set(cacheKey, mode);
      return toResponse(attempt, model, flavor, true);
    }

    // Empty content. If the model spent its budget on reasoning, or was cut off,
    // a different JSON mode will not help - say what actually happened.
    if (attempt.finishReason === "length" || attempt.reasoningOnly) {
      throw emptyError(flavor, attempt);
    }

    failures.push(`${mode}: empty response`);
  }

  throw new Error(
    `${flavor} returned nothing usable for a JSON request. Tried ${failures.length} way(s): ${failures.join(" | ")}`,
  );
}

interface Attempt {
  text: string;
  refusal?: string;
  finishReason?: string;
  inTok: number;
  outTok: number;
  /** The model produced reasoning tokens but no answer. */
  reasoningOnly: boolean;
}

function buildBody(
  model: string,
  messages: unknown[],
  maxTokens: number,
  flavor: CompatFlavor,
  mode: JsonMode | undefined,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages };

  // OpenAI renamed this; most other servers only understand the old name, and
  // some ignore an unknown field and then truncate at a tiny default.
  if (flavor === "openai") body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;

  if (mode === "json_schema" && schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "agent_step", strict: false, schema },
    };
  } else if (mode === "json_object") {
    body.response_format = { type: "json_object" };
  }
  // prompt_only sends nothing: the system prompt already demands JSON, and
  // extractJson tolerates fences or a short preamble.

  return body;
}

async function once(
  base: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Attempt> {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // Carry the status so the retry layer can tell a blip from a bad request.
    throw Object.assign(new Error(`${res.status}: ${detail}`), { status: res.status });
  }

  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
        refusal?: string | null;
        /** vLLM, DeepSeek and others split thinking out into its own field. */
        reasoning_content?: string | null;
        reasoning?: string | null;
      };
      /** Some servers answer in `text` instead of `message.content`. */
      text?: string;
      finish_reason?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };

  const choice = json.choices?.[0];
  const content = readContent(choice?.message?.content) || (choice?.text ?? "");
  const reasoning =
    choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? "";
  const reasoningTokens = json.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

  return {
    text: content,
    refusal: choice?.message?.refusal ?? undefined,
    finishReason: choice?.finish_reason,
    inTok: json.usage?.prompt_tokens ?? 0,
    outTok: json.usage?.completion_tokens ?? 0,
    reasoningOnly: !content.trim() && (reasoning.trim().length > 0 || reasoningTokens > 0),
  };
}

/** Content can be a string, or the array form some servers echo back. */
function readContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: unknown })?.text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("");
  }
  return "";
}

function emptyError(flavor: CompatFlavor, attempt: Attempt): Error {
  if (attempt.reasoningOnly) {
    return new Error(
      `${flavor} spent its whole output budget on reasoning and returned no answer. Raise the model's token limit, or pick a model that is not a reasoning model for this role.`,
    );
  }
  if (attempt.finishReason === "length") {
    return new Error(
      `${flavor} hit its output limit before returning anything usable (finish_reason=length).`,
    );
  }
  return new Error(
    `${flavor} returned an empty response${attempt.finishReason ? ` (finish_reason=${attempt.finishReason})` : ""}.`,
  );
}

function toResponse(
  attempt: Attempt,
  model: string,
  flavor: CompatFlavor,
  wantJson: boolean,
): LlmResponse {
  return {
    text: wantJson ? extractJson(attempt.text) : attempt.text,
    // A local model costs nothing to run.
    usd: flavor === "ollama" ? 0 : costUsd(model, attempt.inTok, attempt.outTok),
    inputTokens: attempt.inTok,
    outputTokens: attempt.outTok,
    refusal: attempt.refusal,
  };
}

/**
 * Accepts the base URL in whatever form a user pastes it: with or without a
 * trailing slash, /v1, or the full /chat/completions path.
 */
function normalizeBase(raw: string): string {
  let base = raw.replace(/\/+$/, "");
  if (!base) return "";
  base = base.replace(/\/chat\/completions$/i, "");
  return base.replace(/\/+$/, "");
}
