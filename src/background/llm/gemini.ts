import { costUsd, extractJson, type LlmRequest, type LlmResponse } from "./types";

export async function callGemini(
  req: LlmRequest,
  model: string,
  key: string,
  baseUrl: string | undefined,
  _effort?: string,
): Promise<LlmResponse> {
  const base = baseUrl?.replace(/\/+$/, "") ?? "https://generativelanguage.googleapis.com/v1beta";

  const contents = req.messages.map((m) => {
    const parts: Array<Record<string, unknown>> = [];
    if (m.imageDataUrl) {
      const [, media = "image/png", data = ""] =
        /^data:([^;]+);base64,(.*)$/.exec(m.imageDataUrl) ?? [];
      parts.push({ inline_data: { mime_type: media, data } });
    }
    parts.push({ text: m.content });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: req.maxTokens ?? 8000,
  };
  if (req.schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = stripUnsupported(req.schema);
  }

  const res = await fetch(`${base}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents,
      generationConfig,
    }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text =
    json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const inTok = json.usageMetadata?.promptTokenCount ?? 0;
  const outTok = json.usageMetadata?.candidatesTokenCount ?? 0;

  return {
    text: req.schema ? extractJson(text) : text,
    usd: costUsd(model, inTok, outTok),
    inputTokens: inTok,
    outputTokens: outTok,
  };
}

/** Gemini's schema dialect rejects some JSON Schema keywords. */
function stripUnsupported(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripUnsupported);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === "additionalProperties" || k === "$schema" || k === "oneOf") continue;
      out[k] = stripUnsupported(v);
    }
    return out;
  }
  return schema;
}
