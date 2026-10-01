/**
 * What the left strip says, decided apart from the markup that draws it:
 * one mark per workspace, in deck order — the way between workspaces —
 * and, when the strip slides open, each workspace's teams under it (user
 * decision 2026-10-01: the reveal is the team switcher; at rest the strip
 * stays marks only).
 *
 * A mark is the only view into a workspace that is not on screen, so it
 * wears that workspace's loudest state, whatever it is — failed, waiting,
 * working, done, or a hollow idle — and no dot only when nobody is there.
 * The dots are folded HERE, from the live activities a single subscription
 * carries in ([`usePaneActivities`]): each team's from its own members
 * ([`teamDot`]), then the workspace's from its teams'.
 *
 * It also names the ACTIVE workspace and where it sits, for the bar's crumb
 * (`workspaceCrumbView`).
 */
import { membersOf, openTeamOf, teamsOf, type Workspace, type WorkspaceView } from "../domain/deck";
import { foldFrame, type PaneActivity } from "../domain/status";
import type { ActiveWorkspace } from "./workspaceCrumbView";
import { TEAM_CARD_WORDS, teamDot, type TeamCardDot } from "./teamCardView";

/** A mark's dot: its workspace's loudest state. */
export type MarkDot = "failed" | "waiting" | "working" | "done" | "idle";

/** One team under its workspace in the slid-open strip. */
export interface StripTeam {
  id: string;
  name: string;
  /** The team's own dot, UNREDUCED — creating and idle say themselves here,
   * where the mark folds them away. */
  dot: TeamCardDot;
  /** The team the workspace has open (its stage shows it). */
  open: boolean;
  /** The row's accessible name: the team and how it is doing. */
  label: string;
}

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
  /** Its teams in deck order — what the slid-open strip lists under it. */
  teams: readonly StripTeam[];
}

export interface StripView {
  marks: readonly WorkspaceMark[];
  /** Null only for a deck with no workspace at all. */
  active: ActiveWorkspace | null;
}

export const STRIP_WORDS = {
  /** The strip as a screen reader names it. */
  nav: "Workspaces",
  addWorkspace: "New workspace",
  /** The build at the strip's foot, in full. */
  build: (version: string) => `KeepDeck ${version}`,
  /** The chevron that opens or closes a workspace's team list. */
  showTeams: (workspace: string) => `Show teams of ${workspace}`,
  hideTeams: (workspace: string) => `Hide teams of ${workspace}`,
  /** How many teams a closed list holds, as the row says it. */
  teamCount: (count: number) => String(count),
} as const;

const DOT_WORDS: Record<MarkDot, string> = {
  failed: "something failed",
  waiting: "someone needs you",
  working: "working",
  done: "done",
  idle: "idle",
};

/** A team dot as a rung of the pane ladder, so the workspace folds its
 * teams through the ONE ladder (`foldFrame`) instead of a second table. A
 * failed create is `failed`, loud as a failed turn; a create in flight is
 * nothing yet — the card says it, a mark has no room to say it gently. */
function asState(dot: TeamCardDot): PaneActivity["state"] | undefined {
  return dot === "creating" || dot === "none" ? undefined : dot;
}

/** A workspace's loudest state from its teams' dots, else idle while
 * anyone is there, else no dot. */
function markDot(teamDots: readonly TeamCardDot[], agents: number): MarkDot | null {
  const frame = foldFrame(teamDots.map(asState));
  if (frame !== "none") return frame;
  return agents > 0 ? "idle" : null;
}

/**
 * The mark's letters: the initials of the first two words ("KeepDeck" →
 * "KD", "web app" → "wa"), else the first two letters of the one word
 * ("mnemo" → "mn"). Words part at spaces, dots, dashes, underscores and a
 * lower-to-upper case step.
 */
function workspaceInitials(name: string): string {
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
  activeId: string,
  /** Each workspace's view — which team its stage has open. */
  viewByWs: Readonly<Record<string, WorkspaceView>>,
): StripView {
  let active = null as ActiveWorkspace | null;
  const marks = workspaces.map((ws, index): WorkspaceMark => {
    const openTeam = openTeamOf(ws, viewByWs[ws.id]);
    // ONE pass: each team's dot is the row's, and the same dots fold into
    // the mark's — the two can never rank a team differently.
    const teams = teamsOf(ws).map((team): StripTeam => {
      const teamState = teamDot(team, membersOf(ws, team.id).map((pane) => activities.get(pane.id)));
      return {
        id: team.id,
        name: team.name,
        dot: teamState,
        open: team.id === openTeam?.id,
        label: `${team.name} — ${TEAM_CARD_WORDS.dot[teamState]}`,
      };
    });
    const dot = markDot(teams.map((team) => team.dot), ws.panes.length);
    if (ws.id === activeId) {
      active = {
        id: ws.id,
        name: ws.name,
        moveUpTo: index > 0 ? index - 1 : null,
        moveDownTo: index < workspaces.length - 1 ? index + 1 : null,
      };
    }
    return {
      id: ws.id,
      name: ws.name,
      initials: workspaceInitials(ws.name),
      active: ws.id === activeId,
      dot,
      label: dot ? `${ws.name} — ${DOT_WORDS[dot]}` : ws.name,
      teams,
    };
  });
  return { marks, active };
}
