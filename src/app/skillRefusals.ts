/**
 * The spawn cwds skills could not be armed in, and why.
 *
 * A STANDING CONDITION, not an event: the user's own `.agents` file sits
 * there until they move it, so the list is republished by every arming
 * pass and simply becomes empty when the cause is gone. Nothing here
 * expires, retries or remembers — freshness comes from arming being asked
 * every time rather than from anything this store does.
 */
import type { SkillArmRefusal } from "../ipc/skills";

export interface SkillRefusalStore {
  get(): readonly SkillArmRefusal[];
  subscribe(listener: () => void): () => void;
  publish(refusals: readonly SkillArmRefusal[]): void;
}

const same = (
  a: readonly SkillArmRefusal[],
  b: readonly SkillArmRefusal[],
): boolean =>
  a.length === b.length &&
  a.every((x, i) => x.root === b[i].root && x.reason === b[i].reason);

export function createSkillRefusalStore(): SkillRefusalStore {
  let current: readonly SkillArmRefusal[] = [];
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(refusals) {
      // Compared by CONTENT, like the mcp surface's: a refusal whose
      // reason changed — they deleted the file and made the directory
      // their own — keeps the length while saying something else.
      if (same(refusals, current)) return;
      current = [...refusals];
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The app's one store. A module singleton for the same reason settings
 * are: the surface that renders refusals is mounted far from the
 * composition root that produces them, and threading a port through the
 * dialog's whole ancestry would buy nothing. */
export const skillRefusals = createSkillRefusalStore();
