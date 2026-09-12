/**
 * Watching the deck for membership that MOVED — a pane landed on a team,
 * left one, changed role — and naming the panes whose standing that changed.
 *
 * Membership has one writer, the deck, and many doors: the dialog,
 * `team.add`, `agent.spawn`, a relocation, a roster settled over MCP. The
 * briefing that tells an agent where it stands used to be called by ONE of
 * those doors, and when that door was rebuilt the call went with it — every
 * team made through the new doors ran unbriefed. Read off the deck, the
 * signal cannot be forgotten by a door, because no door is asked.
 *
 * A restore is not a move. Hydrating the deck at launch re-reads a roster
 * that was written and briefed last time, and a restored pane resumes a
 * session that was already told — so while the deck is restoring, what
 * arrives becomes the baseline and briefs nobody. The same rule the role
 * catalog follows: changes only, never the boot load.
 */
import {
  membersOn,
  rosterChanges,
  rosterOf,
  type Roster,
  type Workspace,
} from "../../domain/deck";

export interface MembershipWatchDeps {
  workspaces(): readonly Workspace[];
  subscribe(listener: () => void): () => void;
  /** Whether the deck is still being read back from disk — see above. */
  restoring(): boolean;
}

export interface MembershipWatch {
  /** Told the panes now standing on every team whose roster moved — the
   * whole roster of each, because every member's picture of its team is
   * stale when one of them changes, not only the newcomer's. */
  onChanged(listener: (paneIds: readonly string[]) => void): () => void;
  dispose(): void;
}

export function createMembershipWatch(deps: MembershipWatchDeps): MembershipWatch {
  const listeners = new Set<(paneIds: readonly string[]) => void>();
  let baseline: Roster = rosterOf(deps.workspaces());
  const unsubscribe = deps.subscribe(() => {
    const next = rosterOf(deps.workspaces());
    if (deps.restoring()) {
      baseline = next;
      return;
    }
    const moved = rosterChanges(baseline, next);
    baseline = next;
    if (moved.length === 0) return;
    const panes = membersOn(next, moved);
    if (panes.length === 0) return;
    for (const listener of [...listeners]) listener(panes);
  });
  return {
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      unsubscribe();
      listeners.clear();
    },
  };
}
