import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { Settings } from "../shared/types";
import { applyRoleLink } from "../shared/credentials";

const KEY = "settings";

/**
 * Settings live in chrome.storage.local, which is not strongly protected. The
 * settings UI tells the user this; treat keys as recoverable by anything with
 * access to the profile directory.
 */
export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const saved = stored[KEY] as Partial<Settings> | undefined;
  if (!saved) return DEFAULT_SETTINGS;
  return applyRoleLink({
    providers: { ...DEFAULT_SETTINGS.providers, ...saved.providers },
    roles: {
      planner: { ...DEFAULT_SETTINGS.roles.planner, ...saved.roles?.planner },
      executor: { ...DEFAULT_SETTINGS.roles.executor, ...saved.roles?.executor },
      verifier: { ...DEFAULT_SETTINGS.roles.verifier, ...saved.roles?.verifier },
    },
    policy: { ...DEFAULT_SETTINGS.policy, ...saved.policy },
    vision: saved.vision ?? DEFAULT_SETTINGS.vision,
    linkRoles: saved.linkRoles ?? DEFAULT_SETTINGS.linkRoles,
  });
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  // Mirror before persisting, so the stored copy matches what the agent will use.
  const next = applyRoleLink({ ...(await getSettings()), ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
