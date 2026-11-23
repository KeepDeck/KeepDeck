/**
 * What could not be planted in a pane's cwd for an agent, and why — the paths
 * an agent's plugin declared (`arm.plan`) that a folder refused: the user's
 * own file in the way, a parent that is not a directory, a folder gone.
 *
 * A STANDING CONDITION, not an event: it holds until the user moves their
 * file, so each arming pass replaces what it said about its agent in its
 * folder, and a folder no pane on the deck runs in any more is forgotten —
 * the lifecycle machine takes its plantings back when it closes the last
 * of them. Nothing here expires on a timer.
 */

export interface ArmRefusal {
  agentId: string;
  cwd: string;
  path: string;
  reason: string;
}

export interface ArmRefusalStore {
  get(): readonly ArmRefusal[];
  subscribe(listener: () => void): () => void;
  /** One pass's word on one agent in one folder: replaces what was said
   * about that pair before, an empty list included. */
  record(agentId: string, cwd: string, refused: readonly { path: string; reason: string }[]): void;
  /** The folders panes still run in: what was said about any other folder
   * goes — its plantings were taken back with its last pane. */
  retain(cwds: ReadonlySet<string>): void;
}

const same = (a: readonly ArmRefusal[], b: readonly ArmRefusal[]): boolean =>
  a.length === b.length &&
  a.every(
    (x, i) => x.agentId === b[i].agentId && x.cwd === b[i].cwd && x.path === b[i].path && x.reason === b[i].reason,
  );

export function createArmRefusalStore(): ArmRefusalStore {
  let current: readonly ArmRefusal[] = [];
  const listeners = new Set<() => void>();
  function publish(next: readonly ArmRefusal[]): void {
    // Compared by CONTENT: a refusal whose reason changed keeps the length
    // while saying something else.
    if (same(next, current)) return;
    current = next;
    for (const listener of [...listeners]) listener();
  }
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record(agentId, cwd, refused) {
      publish([
        ...current.filter((r) => !(r.agentId === agentId && r.cwd === cwd)),
        ...refused.map(({ path, reason }) => ({ agentId, cwd, path, reason })),
      ]);
    },
    retain(cwds) {
      publish(current.filter((r) => cwds.has(r.cwd)));
    },
  };
}

/** The app's one store, a module singleton for the reason the skill
 * refusals are one: the surface that shows it is mounted far from the
 * composition root that fills it. */
export const armRefusals = createArmRefusalStore();
