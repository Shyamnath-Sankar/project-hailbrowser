import type { Settings } from "./types";

/**
 * Model slots. The planner gets the strong model, the executor a fast one, and
 * the verifier the cheapest thing that can answer yes/no reliably.
 */
export const DEFAULT_SETTINGS: Settings = {
  providers: {},
  linkRoles: false,
  roles: {
    planner: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
    executor: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
    verifier: { provider: "anthropic", model: "claude-haiku-4-5" },
  },
  policy: {
    confirmBeforeSubmit: true,
    quizPolicy: "ask",
    videoStrategy: "skip",
    videoRate: 1,
    videoCaptions: true,
    videoStallSeconds: 45,
    maxUsd: 5,
    maxSteps: 2000,
    maxMinutes: 240,
  },
  vision: "auto",
};

export const MODEL_SUGGESTIONS: Record<string, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
  openai: ["gpt-5.1", "gpt-5-mini"],
  gemini: ["gemini-3-pro", "gemini-3-flash"],
  openrouter: ["anthropic/claude-sonnet-5-5", "google/gemini-3-flash"],
  ollama: ["qwen3:14b", "llama3.3"],
  // A custom gateway defines its own names, so there is nothing useful to suggest.
  openai_compatible: [],
};

