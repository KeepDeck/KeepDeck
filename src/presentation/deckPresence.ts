/**
 * Whether there is a deck to show — the one place the screens that depend on
 * it ask: the welcome screen, where New Workspace leads, and whether the
 * create form is on screen (which the layering then treats as a modal layer).
 *
 * The welcome screen is the way in when there is no workspace at all, and
 * then it is the ONLY way in: New Workspace opens its folder picker, and a
 * form asked for over it never paints. Once a workspace exists, the form
 * opens over the deck — whatever the strip happens to draw.
 */
import type { Workspace } from "../domain/deck";

export interface DeckPresence {
  /** No workspace at all: the welcome screen replaces the deck. */
  welcome: boolean;
  /** Where New Workspace (⌘N, the strip's «+») leads: with a workspace, the
   * form over the deck; with none, the welcome screen's folder picker — the
   * screen IS the way in, and a form over it would be a second one. */
  newWorkspace: "form" | "welcome";
  /** The create form is on screen: asked for, and over a deck. */
  formOpen: boolean;
  /** There are workspaces, and every one is archived: nothing to draw, and
   * the stage says where they went instead of standing empty. */
  allArchived: boolean;
}

/** What the stage says when every workspace is archived. */
export const ALL_ARCHIVED_WORDS = {
  title: "Every workspace is archived",
  body: "They are all kept — teams, worktrees, boards and artifacts — and nothing in them runs. Restore one to work in it again.",
  open: "Show archived workspaces",
  create: "New workspace",
} as const;

export function deckPresence(
  workspaces: readonly Workspace[],
  /** The person asked for the create form. */
  creating: boolean,
): DeckPresence {
  const welcome = workspaces.length === 0;
  return {
    welcome,
    newWorkspace: welcome ? "welcome" : "form",
    formOpen: creating && !welcome,
    allArchived: !welcome && workspaces.every((ws) => ws.archived !== undefined),
  };
}
