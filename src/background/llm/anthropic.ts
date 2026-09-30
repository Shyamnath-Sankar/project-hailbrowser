import Anthropic from "@anthropic-ai/sdk";
import { costUsd, type LlmRequest, type LlmResponse } from "./types";

/** Models that accept adaptive thinking + effort rather than budget_tokens. */
const ADAPTIVE = /^claude-(opus-5|opus-5-5|sonnet-5-5|sonnet-5|fable-5)/;
/** Models where server-side refusal fallbacks are available. */
const FALLBACK_OK = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1|fable-5)$/;

function client(key: string): Anthropic {
  return new Anthropic({
    apiKey: key,
    // The key lives in this extension's own storage and the user supplied it,
    // so direct browser calls are the intended path here.
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });
}

export async function callAnthropic(
  req: LlmRequest,
  model: string,
  key: string,
  _baseUrl: string | undefined,
  effort?: string,
): Promise<LlmResponse> {
  const anthropic = client(key);

  const messages: Anthropic.MessageParam[] = req.messages.map((m) => {
    if (!m.imageDataUrl) return { role: m.role, content: m.content };
    const [, media = "image/png", data = ""] =
      /^data:([^;]+);base64,(.*)$/.exec(m.imageDataUrl) ?? [];
    const content: Anthropic.ContentBlockParam[] = [
      {
        type: "image",
        source: { type: "base64", media_type: media as "image/png", data },
      },
      { type: "text", text: m.content },
    ];
    return { role: m.role, content };
  });

  const outputConfig: Anthropic.Beta.Messages.BetaOutputConfig = {};
  if (effort) outputConfig.effort = effort as Anthropic.Beta.Messages.BetaOutputConfig["effort"];
  if (req.schema) outputConfig.format = { type: "json_schema", schema: req.schema };

  const body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: req.maxTokens ?? 8000,
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages,
  };
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  if (ADAPTIVE.test(model)) body.thinking = { type: "adaptive" };

  const betas: string[] = [];
  if (FALLBACK_OK.test(model)) {
    // Page content can trip a safety classifier; route around it instead of
    // failing the whole task.
    betas.push("server-side-fallback-2026-07-01");
    body.fallbacks = "default";
  }

  const res = await anthropic.beta.messages.create(
    betas.length ? { ...body, betas } : body,
  );

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const inTok = res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0);
  const outTok = res.usage.output_tokens;

  return {
    text,
    usd: costUsd(res.model ?? model, inTok, outTok),
    inputTokens: inTok,
    outputTokens: outTok,
    refusal:
      res.stop_reason === "refusal"
        ? (res.stop_details?.explanation ?? "model declined this request")
        : undefined,
  };
}
