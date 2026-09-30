import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./defaults";
import { credentialProblem, isConfigured, resolveCredentials } from "./credentials";
import type { RoleModel, Settings } from "./types";

/**
 * Each role carries its own credentials so two roles on the same provider stay
 * independent, but a single key must not have to be typed three times. These
 * tests pin down that tension.
 */
function settings(roles: Partial<Record<keyof Settings["roles"], Partial<RoleModel>>>, providers?: Settings["providers"]): Settings {
  return {
    ...DEFAULT_SETTINGS,
    providers: providers ?? {},
    roles: {
      planner: { ...DEFAULT_SETTINGS.roles.planner, ...roles.planner },
      executor: { ...DEFAULT_SETTINGS.roles.executor, ...roles.executor },
      verifier: { ...DEFAULT_SETTINGS.roles.verifier, ...roles.verifier },
    },
  };
}

describe("resolveCredentials", () => {
  it("keeps two roles on the same provider fully independent", () => {
    // The bug this replaced: both roles shared one entry keyed by provider, so
    // pointing the executor at a local endpoint clobbered the planner's.
    const s = settings({
      planner: {
        provider: "openai_compatible",
        model: "big-model",
        baseUrl: "https://hosted.example.com/v1",
        apiKey: "hosted-key",
      },
      executor: {
        provider: "openai_compatible",
        model: "small-model",
        baseUrl: "http://localhost:8000/v1",
        apiKey: "local-key",
      },
    });

    const planner = resolveCredentials(s, "planner");
    const executor = resolveCredentials(s, "executor");

    expect(planner.baseUrl).toBe("https://hosted.example.com/v1");
    expect(planner.apiKey).toBe("hosted-key");
    expect(executor.baseUrl).toBe("http://localhost:8000/v1");
    expect(executor.apiKey).toBe("local-key");
  });

  it("lends a key between roles on the same provider, so it is typed once", () => {
    const s = settings({
      planner: { provider: "anthropic", model: "opus", apiKey: "sk-ant" },
      executor: { provider: "anthropic", model: "sonnet" },
      verifier: { provider: "anthropic", model: "haiku" },
    });

    const executor = resolveCredentials(s, "executor");
    expect(executor.apiKey).toBe("sk-ant");
    // Reported so the UI can explain why a blank field still works.
    expect(executor.keyFrom).toBe("planner");
    expect(resolveCredentials(s, "planner").keyFrom).toBeUndefined();
  });

  it("does not lend a key across different providers", () => {
    const s = settings({
      planner: { provider: "anthropic", model: "opus", apiKey: "sk-ant" },
      executor: { provider: "openai", model: "gpt-5.1" },
    });
    expect(resolveCredentials(s, "executor").apiKey).toBe("");
    expect(credentialProblem(s, "executor")).toMatch(/API key/);
  });

  it("falls back to the shared provider map saved by an earlier version", () => {
    const s = settings(
      { executor: { provider: "anthropic", model: "sonnet" } },
      { anthropic: { apiKey: "legacy-key" } },
    );
    const executor = resolveCredentials(s, "executor");
    expect(executor.apiKey).toBe("legacy-key");
    expect(executor.keyFrom).toBe("shared");
  });

  it("prefers a role's own key over anything it could borrow", () => {
    const s = settings(
      {
        planner: { provider: "anthropic", model: "opus", apiKey: "from-planner" },
        executor: { provider: "anthropic", model: "sonnet", apiKey: "own-key" },
      },
      { anthropic: { apiKey: "shared-key" } },
    );
    const executor = resolveCredentials(s, "executor");
    expect(executor.apiKey).toBe("own-key");
    expect(executor.keyFrom).toBeUndefined();
  });

  it("treats a whitespace-only key as absent rather than as a value", () => {
    const s = settings({
      planner: { provider: "anthropic", model: "opus", apiKey: "sk-real" },
      executor: { provider: "anthropic", model: "sonnet", apiKey: "   " },
    });
    expect(resolveCredentials(s, "executor").apiKey).toBe("sk-real");
  });
});

describe("credentialProblem", () => {
  it("accepts a local provider with no key at all", () => {
    const s = settings({ executor: { provider: "ollama", model: "qwen3:14b" } });
    expect(credentialProblem(s, "executor")).toBeNull();
  });

  it("requires a base URL for a custom endpoint, since there is no default", () => {
    const s = settings({
      executor: { provider: "openai_compatible", model: "local", apiKey: "k" },
    });
    expect(credentialProblem(s, "executor")).toMatch(/base URL/);

    const fixed = settings({
      executor: {
        provider: "openai_compatible",
        model: "local",
        apiKey: "k",
        baseUrl: "http://localhost:8000/v1",
      },
    });
    expect(credentialProblem(fixed, "executor")).toBeNull();
  });

  it("catches an empty model name", () => {
    const s = settings({ executor: { provider: "ollama", model: "  " } });
    expect(credentialProblem(s, "executor")).toMatch(/model/);
  });
});

describe("isConfigured", () => {
  it("is false when any single role cannot run", () => {
    // A missing verifier key must surface in settings, not mid-task.
    const s = settings({
      planner: { provider: "anthropic", model: "opus", apiKey: "k" },
      executor: { provider: "anthropic", model: "sonnet", apiKey: "k" },
      verifier: { provider: "openai", model: "gpt-5-mini" },
    });
    expect(isConfigured(s)).toBe(false);
  });

  it("is true once one key covers every role on that provider", () => {
    const s = settings({
      planner: { provider: "anthropic", model: "opus", apiKey: "k" },
      executor: { provider: "anthropic", model: "sonnet" },
      verifier: { provider: "anthropic", model: "haiku" },
    });
    expect(isConfigured(s)).toBe(true);
  });

  it("is false for a fresh install with no keys", () => {
    expect(isConfigured(DEFAULT_SETTINGS)).toBe(false);
  });
});
