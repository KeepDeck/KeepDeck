/**
 * What the left strip says, decided apart from the markup that draws it.
 *
 * The strip has two halves. The column of MARKS — one per workspace, in
 * deck order, the way between workspaces — and beside it the open
 * workspace's TEAMS, one row each, the way between teams. The stage shows a
 * team, never a level above one, so this list is the only place a team is
 * reached from.
 *
 * The two halves dot differently, because they answer different questions.
 * A MARK is the only view into a workspace that is not on screen, so it
 * wears that workspace's loudest state, whatever it is — failed, waiting,
 * working, done, or a hollow idle — and no dot only when nobody is there.
 * A ROW is a team of the workspace already on screen, whose tiles say how
 * each agent is doing; it speaks only when something needs the person —
 * a failed or waiting agent, or a failed worktree create.
 *
 * The dots are folded HERE, from the live activities a single subscription
 * carries in ([`usePaneActivities`]): each team's from its own members
 * ([`teamDot`]), then the workspace's from its teams'.
 */
import { membersOf, openTeamOf, teamsOf, type Workspace, type WorkspaceViewMap } from "../domain/deck";
import type { PaneActivity } from "../domain/status";
import { teamActions, teamDot, teamPending, type TeamAction, type TeamDot } from "./teamView";

/** The only states a team row draws a dot for. */
export type AttentionDot = "failed" | "waiting";

/** A mark's dot: its workspace's loudest state. */
export type MarkDot = "failed" | "waiting" | "working" | "done" | "idle";

/** One workspace's mark in the column. */
export interface WorkspaceMark {
  id: string;
  name: string;
  /** Up to two letters, what the mark itself says. */
  initials: string;
  active: boolean;
  /** Null only for a workspace nobody is in. */
  dot: MarkDot | null;
  /** The mark's tooltip and accessible name. */
  label: string;
}

/** One team in the open workspace's list. */
export interface TeamRow {
  id: string;
  name: string;
  /** How many agents are on it — the row's number. */
  size: number;
  /** Whether this is the team on the stage. */
  open: boolean;
  /** Whether its directory is not there yet — the row dims. */
  pending: boolean;
  dot: AttentionDot | null;
  actions: readonly TeamAction[];
}

/** The team list's header and rows, for the open workspace. */
export interface TeamList {
  wsId: string;
  wsName: string;
  rows: readonly TeamRow[];
  /** Where the workspace's menu can move it — the keyboard's way to do what
   * a held mark's drag does — or null at that end of the column. */
  moveUpTo: number | null;
  moveDownTo: number | null;
}

export interface StripView {
  marks: readonly WorkspaceMark[];
  /** Null only for a deck with no workspace at all. */
  teams: TeamList | null;
}

export const STRIP_WORDS = {
  addWorkspace: "New workspace",
  addTeam: "New team",
  hideTeams: "Hide teams",
  showTeams: "Show teams",
  noTeams: "No teams yet",
  workspaceMenu: (name: string) => `Workspace ${name} actions`,
  renameWorkspace: "Rename",
  moveUp: "Move up",
  moveDown: "Move down",
  closeWorkspace: "Close workspace",
  renameField: "Workspace name",
} as const;

const DOT_WORDS: Record<MarkDot, string> = {
  failed: "something failed",
  waiting: "someone needs you",
  working: "working",
  done: "done",
  idle: "idle",
};

/** The dot a team's own ladder earns in the strip: only what needs the
 * person. A failed create is `failed` on the ladder already. */
function attention(dot: TeamDot): AttentionDot | null {
  return dot === "failed" || dot === "waiting" ? dot : null;
}

const MARK_LADDER: readonly MarkDot[] = ["failed", "waiting", "working", "done"];

/** A workspace's loudest state from its teams' dots — a create in flight
 * says nothing yet — else idle while anyone is there, else no dot. */
function markDot(teamDots: readonly TeamDot[], agents: number): MarkDot | null {
  const loudest = MARK_LADDER.find((rung) => teamDots.includes(rung as TeamDot));
  return loudest ?? (agents > 0 ? "idle" : null);
}

/**
 * The mark's letters: the initials of the first two words ("KeepDeck" →
 * "KD", "web app" → "wa"), else the first two letters of the one word
 * ("mnemo" → "mn"). Words part at spaces, dots, dashes, underscores and a
 * lower-to-upper case step.
 */
export function workspaceInitials(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._\-/]+/)
    .filter(Boolean);
  if (words.length >= 2) return words[0][0] + words[1][0];
  return (words[0] ?? "?").slice(0, 2);
}

export function stripView(
  workspaces: readonly Workspace[],
  activities: ReadonlyMap<string, PaneActivity>,
  viewByWs: WorkspaceViewMap,
  activeId: string,
): StripView {
  const marks: WorkspaceMark[] = [];
  let teams: TeamList | null = null;
  workspaces.forEach((ws, index) => {
    const shown = openTeamOf(ws, viewByWs[ws.id]);
    const teamDots: TeamDot[] = [];
    const rows = teamsOf(ws).map((team): TeamRow => {
      const members = membersOf(ws, team.id);
      const dot = teamDot(team, members.map((pane) => activities.get(pane.id)));
      teamDots.push(dot);
      return {
        id: team.id,
        name: team.name,
        size: members.length,
        open: team.id === shown?.id,
        pending: teamPending(team),
        dot: attention(dot),
        actions: teamActions(team),
      };
    });
    const active = ws.id === activeId;
    if (active) {
      teams = {
        wsId: ws.id,
        wsName: ws.name,
        rows,
        moveUpTo: index > 0 ? index - 1 : null,
        moveDownTo: index < workspaces.length - 1 ? index + 1 : null,
      };
    }
    const dot = markDot(teamDots, ws.panes.length);
    marks.push({
      id: ws.id,
      name: ws.name,
      initials: workspaceInitials(ws.name),
      active,
      dot,
      label: dot ? `${ws.name} — ${DOT_WORDS[dot]}` : ws.name,
    });
  });
  return { marks, teams };
}
