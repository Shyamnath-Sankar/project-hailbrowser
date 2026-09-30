import type { AgentRole, ProviderId, Settings } from "./types";

export const ROLES: readonly AgentRole[] = ["planner", "executor", "verifier"];

/** Providers that cannot be called at all without a base URL. */
export const REQUIRES_BASE_URL: readonly ProviderId[] = ["openai_compatible"];

/** Providers that work with no API key: a local server, or a private gateway. */
export const KEY_OPTIONAL: readonly ProviderId[] = ["ollama", "openai_compatible"];

/**
 * When `linkRoles` is on, the planner slot is the single source of truth and the
 * other two roles mirror it. Applied on read so every consumer - the router, the
 * readiness check, the settings UI - sees one consistent configuration rather
 * than each having to remember the rule.
 */
export function applyRoleLink(settings: Settings): Settings {
  if (!settings.linkRoles) return settings;
  const source = settings.roles.planner;
  return {
    ...settings,
    roles: { planner: source, executor: { ...source }, verifier: { ...source } },
  };
}

export interface ResolvedCredentials {
  provider: ProviderId;
  model: string;
  effort?: RoleModelEffort;
  apiKey: string;
  baseUrl?: string;
  /** Which role's settings the key came from, when it was not this role's own. */
  keyFrom?: AgentRole | "shared";
  /** Same, for the base URL. */
  baseUrlFrom?: AgentRole | "shared";
}

type RoleModelEffort = NonNullable<Settings["roles"]["planner"]["effort"]>;

/**
 * Works out what to actually send for a role.
 *
 * Each role holds its own credentials, so two roles pointed at different
 * OpenAI-compatible endpoints stay independent. A role that leaves a field blank
 * borrows it from another role on the same provider, then from the shared
 * provider map - which is why one Anthropic key covers all three roles without
 * being typed three times.
 */
export function resolveCredentials(settings: Settings, role: AgentRole): ResolvedCredentials {
  const slot = settings.roles[role];
  const { provider } = slot;

  const ownKey = slot.apiKey?.trim();
  const ownBase = slot.baseUrl?.trim();

  const resolved: ResolvedCredentials = {
    provider,
    model: slot.model,
    effort: slot.effort,
    apiKey: ownKey ?? "",
    baseUrl: ownBase,
  };

  if (!ownKey) {
    const lender = ROLES.find(
      (other) =>
        other !== role &&
        settings.roles[other].provider === provider &&
        (settings.roles[other].apiKey ?? "").trim().length > 0,
    );
    if (lender) {
      resolved.apiKey = settings.roles[lender].apiKey!.trim();
      resolved.keyFrom = lender;
    } else {
      const shared = settings.providers[provider]?.apiKey?.trim();
      if (shared) {
        resolved.apiKey = shared;
        resolved.keyFrom = "shared";
      }
    }
  }

  if (!ownBase) {
    const lender = ROLES.find(
      (other) =>
        other !== role &&
        settings.roles[other].provider === provider &&
        (settings.roles[other].baseUrl ?? "").trim().length > 0,
    );
    if (lender) {
      resolved.baseUrl = settings.roles[lender].baseUrl!.trim();
      resolved.baseUrlFrom = lender;
    } else {
      const shared = settings.providers[provider]?.baseUrl?.trim();
      if (shared) {
        resolved.baseUrl = shared;
        resolved.baseUrlFrom = "shared";
      }
    }
  }

  return resolved;
}

/** Why a role cannot run yet, or null when it is ready. */
export function credentialProblem(settings: Settings, role: AgentRole): string | null {
  const resolved = resolveCredentials(settings, role);
  if (!resolved.model.trim()) return "Needs a model name.";
  if (!resolved.apiKey && !KEY_OPTIONAL.includes(resolved.provider)) return "Needs an API key.";
  if (REQUIRES_BASE_URL.includes(resolved.provider) && !resolved.baseUrl?.trim()) {
    return "Needs a base URL.";
  }
  return null;
}

/** True when every role is configured well enough to attempt a task. */
export function isConfigured(settings: Settings): boolean {
  return ROLES.every((role) => credentialProblem(settings, role) === null);
}
