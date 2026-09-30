import type { PageType } from "../../shared/types";
import { db, type SkillRow } from "../memory/db";
import { BUILTIN_SKILLS } from "./builtin";

/** Seeds built-ins once, without clobbering user edits to the same names. */
export async function ensureSkillsSeeded(): Promise<void> {
  const existing = new Set((await db.skills.toArray()).map((s) => s.name));
  const missing = BUILTIN_SKILLS.filter((s) => !existing.has(s.name));
  if (missing.length) await db.skills.bulkPut(missing);
}

export const listSkills = (): Promise<SkillRow[]> => db.skills.toArray();

export const getSkill = (name: string): Promise<SkillRow | undefined> => db.skills.get(name);

export const upsertSkill = (skill: SkillRow): Promise<string> => db.skills.put(skill);

export async function deleteSkill(name: string): Promise<void> {
  const row = await db.skills.get(name);
  // Built-ins are re-seeded on next start, so deleting one has no lasting effect.
  if (row?.builtin) return;
  await db.skills.delete(name);
}

/**
 * Skills whose triggers match the current page. Only names and descriptions go
 * into the prompt; the agent calls load_skill for the body it wants.
 */
export async function candidateSkills(pageType: PageType, url: string): Promise<SkillRow[]> {
  const host = safeHost(url);
  const all = await db.skills.toArray();
  return all.filter((s) => {
    const byPage = s.pageTypes.length === 0 || s.pageTypes.includes(pageType);
    const byHost = s.hosts.length === 0 || s.hosts.some((h) => host.includes(h));
    // A host-scoped skill must match its host; an unscoped one matches on page type alone.
    return s.hosts.length > 0 ? byHost && byPage : byPage;
  });
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
