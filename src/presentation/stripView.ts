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
 * It also describes the ACTIVE workspace for the bar's crumb, whose menu
 * renames, moves and closes it.
 */
import { membersOf, teamsOf, type Workspace } from "../domain/deck";
import type { PaneActivity } from "../domain/status";
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

/** The workspace on screen, as the bar's crumb names it and its menu acts
 * on it. */
export interface ActiveWorkspace {
  id: string;
  name: string;
  /** Where the menu can move it — the keyboard's way to do what a held
   * mark's drag does — or null at that end of the column. */
  moveUpTo: number | null;
  moveDownTo: number | null;
}

export interface StripView {
  marks: readonly WorkspaceMark[];
  /** Null only for a deck with no workspace at all. */
  active: ActiveWorkspace | null;
}

export const STRIP_WORDS = {
  addWorkspace: "New workspace",
} as const;

/** The bar's crumb for the active workspace, and its menu. */
export const WORKSPACE_WORDS = {
  menu: (name: string) => `Workspace ${name} actions`,
  rename: "Rename",
  moveUp: "Move up",
  moveDown: "Move down",
  close: "Close workspace",
  renameField: "Workspace name",
} as const;

/** One line of the workspace's menu, described — the crumb performs it. A
 * move carries where it goes, or null when that end of the column is
 * already reached and the line is refused. */
export type WorkspaceMenuItem = { id: string; label: string; disabled: boolean } & (
  | { kind: "rename" }
  | { kind: "move"; to: number | null }
  | { kind: "close" }
);

/** The workspace menu, in the order it is offered. */
export function workspaceMenuView(active: ActiveWorkspace): WorkspaceMenuItem[] {
  return [
    { id: "rename", kind: "rename", label: WORKSPACE_WORDS.rename, disabled: false },
    { id: "up", kind: "move", label: WORKSPACE_WORDS.moveUp, to: active.moveUpTo, disabled: active.moveUpTo === null },
    {
      id: "down",
      kind: "move",
      label: WORKSPACE_WORDS.moveDown,
      to: active.moveDownTo,
      disabled: active.moveDownTo === null,
    },
    { id: "close", kind: "close", label: WORKSPACE_WORDS.close, disabled: false },
  ];
}

const DOT_WORDS: Record<MarkDot, string> = {
  failed: "something failed",
  waiting: "someone needs you",
  working: "working",
  done: "done",
  idle: "idle",
};

const MARK_LADDER: readonly MarkDot[] = ["failed", "waiting", "working", "done"];

/** A workspace's loudest state from its teams' dots — a create in flight
 * says nothing yet — else idle while anyone is there, else no dot. */
function markDot(teamDots: readonly TeamCardDot[], agents: number): MarkDot | null {
  const loudest = MARK_LADDER.find((rung) => teamDots.includes(rung as TeamCardDot));
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
