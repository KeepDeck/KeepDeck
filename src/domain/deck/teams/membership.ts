/**
 * The deck's roster as one reading, and what moved between two readings.
 *
 * Membership has ONE writer — the reducer — and many doors: the dialog,
 * `team.add`, `agent.spawn`, a relocation, a roster settled over MCP. Whoever
 * has to act on "this pane is now on that team" (the briefing that tells the
 * agent so) reads it HERE, off the deck, instead of being called by each
 * door in turn. A door that forgot to call is exactly how the briefing was
 * lost once: the roster dialog that used to call it was deleted, and the
 * doors that replaced it never had.
 */
import type { Workspace } from "../workspaces";

/** Where one pane stands: its workspace, its team, its role. */
export interface RosterEntry {
  workspaceId: string;
  teamId: string;
  role: string;
}

/** A team, named the way a roster change names it. */
export interface RosterTeam {
  workspaceId: string;
  teamId: string;
}

/** Every teamed pane's standing, keyed by pane id — the deck mints pane ids
 * from one sequence, so an id names one pane across every workspace. */
export type Roster = ReadonlyMap<string, RosterEntry>;

/** A team as a map key: team ids are per workspace. */
const keyOf = (team: RosterTeam): string => `${team.workspaceId}/${team.teamId}`;

export function rosterOf(workspaces: readonly Workspace[]): Roster {
  const roster = new Map<string, RosterEntry>();
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      if (!pane.team) continue;
      roster.set(pane.id, {
        workspaceId: workspace.id,
        teamId: pane.team.teamId,
        role: pane.team.role,
      });
    }
  }
  return roster;
}

/**
 * The teams whose roster differs between `before` and `after`: a member
 * arrived, left, changed role, or moved — and a move touches both teams,
 * because each of them has a roster that no longer says what it said.
 *
 * Teams, not panes, because a roster is what a briefing states: when one
 * member changes, every member's picture of the team is stale, not only
 * the newcomer's.
 */
export function rosterChanges(before: Roster, after: Roster): RosterTeam[] {
  const moved = new Map<string, RosterTeam>();
  const touch = (entry: RosterEntry) =>
    moved.set(keyOf(entry), { workspaceId: entry.workspaceId, teamId: entry.teamId });
  for (const [paneId, was] of before) {
    const now = after.get(paneId);
    if (!now) {
      touch(was);
      continue;
    }
    if (now.workspaceId !== was.workspaceId || now.teamId !== was.teamId) {
      touch(was);
      touch(now);
      continue;
    }
    if (now.role !== was.role) touch(now);
  }
  for (const [paneId, now] of after) {
    if (!before.has(paneId)) touch(now);
  }
  return [...moved.values()];
}

/** The panes that stand on any of `teams` in `roster`, in roster order. */
export function membersOn(roster: Roster, teams: readonly RosterTeam[]): string[] {
  const wanted = new Set(teams.map(keyOf));
  const panes: string[] = [];
  for (const [paneId, entry] of roster) {
    if (wanted.has(keyOf(entry))) panes.push(paneId);
  }
  return panes;
}
