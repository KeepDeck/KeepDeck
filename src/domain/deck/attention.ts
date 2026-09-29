/**
 * Who is blocked on the person, across the deck — the rule behind the
 * bar's "N need you" and ⌘J, and what any other surface (a command, an
 * agent asking "who waits on me") would ask. Words are not here; the
 * presentation says them.
 *
 * A pane counts when its agent's state needs a person (`needsPerson`), it
 * has a process to answer (an idle pane's last "waiting" is not a
 * request), and it is on a team — a pane outside every team (legacy data)
 * has no card to be reached from, so listing it would be a row that leads
 * nowhere. Order: louder first (failed before waiting), then the longest
 * blocked.
 */
import { bySeverity, needsPerson, type PaneActivity } from "../status";
import type { Pane } from "./panes";
import { findTeam } from "./teams/collection";
import type { Team } from "./teams/model";
import type { Workspace } from "./workspaces";

export interface BlockedAgent {
  ws: Workspace;
  pane: Pane;
  /** The pane's place in its workspace — its display title numbers by it. */
  index: number;
  team: Team;
  activity: PaneActivity;
  /** When it became blocked. */
  since: number;
}

function sinceOf(activity: PaneActivity): number {
  return "since" in activity ? activity.since : activity.at;
}

export function blockedAgents(
  workspaces: readonly Workspace[],
  activities: ReadonlyMap<string, PaneActivity>,
): BlockedAgent[] {
  const found: BlockedAgent[] = [];
  for (const ws of workspaces) {
    ws.panes.forEach((pane, index) => {
      const activity = activities.get(pane.id);
      if (!activity || !needsPerson(activity.state) || pane.idle) return;
      const team = pane.team && findTeam(ws, pane.team.teamId);
      if (!team) return;
      found.push({ ws, pane, index, team, activity, since: sinceOf(activity) });
    });
  }
  return found.sort(
    (a, b) => bySeverity(a.activity.state, b.activity.state) || a.since - b.since,
  );
}
