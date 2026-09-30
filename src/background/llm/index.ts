import type { AgentRole, ProviderId, Settings } from "../../shared/types";
import { KEY_OPTIONAL, REQUIRES_BASE_URL, resolveCredentials } from "../../shared/credentials";
import { callAnthropic } from "./anthropic";
import { callGemini } from "./gemini";
import { callOpenAiCompat } from "./openai-compat";
import { withRetry, type LlmRequest, type LlmResponse } from "./types";

export class MissingKeyError extends Error {
  constructor(
    public provider: ProviderId,
    public role: AgentRole,
  ) {
    super(`The ${role} has no API key for ${provider}. Add one in Settings.`);
    this.name = "MissingKeyError";
  }
}

export class MissingBaseUrlError extends Error {
  constructor(
    public provider: ProviderId,
    public role: AgentRole,
  ) {
    super(
      `The ${role} needs a base URL for ${provider} (the part before /chat/completions). Add one in Settings.`,
    );
    this.name = "MissingBaseUrlError";
  }
}

/**
 * Routes a role's request to its own provider, with its own credentials. Roles
 * are independent, so the executor can sit on a local endpoint while the planner
 * uses a hosted one.
 */
export async function callModel(
  settings: Settings,
  role: AgentRole,
  req: Omit<LlmRequest, "role">,
): Promise<LlmResponse> {
  const { provider, model, effort, apiKey, baseUrl } = resolveCredentials(settings, role);

  if (!apiKey && !KEY_OPTIONAL.includes(provider)) throw new MissingKeyError(provider, role);
  if (REQUIRES_BASE_URL.includes(provider) && !baseUrl?.trim()) {
    throw new MissingBaseUrlError(provider, role);
  }

  const full: LlmRequest = { ...req, role };

  // One retry wrapper for every provider: a long task will meet a 429 or a 503,
  // and losing hours of work to a blip that clears in two seconds is the worst
  // possible failure mode here.
  return withRetry(`${provider} (${role})`, () => {
    switch (provider) {
      case "anthropic":
        return callAnthropic(full, model, apiKey, baseUrl, effort);
      case "gemini":
        return callGemini(full, model, apiKey, baseUrl, effort);
      case "openai":
        return callOpenAiCompat(full, model, apiKey, baseUrl, effort, "openai");
      case "openrouter":
        return callOpenAiCompat(full, model, apiKey, baseUrl, effort, "openrouter");
      case "ollama":
        return callOpenAiCompat(full, model, apiKey, baseUrl, effort, "ollama");
      case "openai_compatible":
        return callOpenAiCompat(full, model, apiKey, baseUrl, effort, "custom");
    }
  });
}
