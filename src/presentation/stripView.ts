/**
 * What the left strip says, decided apart from the markup that draws it:
 * one mark per workspace, in deck order — the way between workspaces.
 * Teams are reached on the stage's own cards screen, not here.
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
import { membersOf, teamsOf, type Workspace } from "../domain/deck";
import { foldFrame, type PaneActivity } from "../domain/status";
import type { ActiveWorkspace } from "./workspaceCrumbView";
import { teamDot, type TeamCardDot } from "./teamCardView";

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
): StripView {
  let active = null as ActiveWorkspace | null;
  const marks = workspaces.map((ws, index): WorkspaceMark => {
    const teamDots = teamsOf(ws).map((team) =>
      teamDot(team, membersOf(ws, team.id).map((pane) => activities.get(pane.id))),
    );
    const dot = markDot(teamDots, ws.panes.length);
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
    };
  });
  return { marks, active };
}
