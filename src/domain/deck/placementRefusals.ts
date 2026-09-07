/**
 * Why a directory would not take a team or a pane, and what that is called
 * in words — one table, so the SAME refusal does not reach one door as "that
 * directory is already a team's" and another as "try again in a moment".
 *
 * The reasons are the product's, not a layer's: an agent driving `team.create`
 * and a person pressing "+ Team" must be told the same thing, which is why
 * the words live beside the model rather than in either surface.
 */

/** Why a placement was refused. Every `held` outcome carries one. */
export type PlacementRefusal =
  /** A team in ANOTHER workspace works there. A team never spans workspaces,
   * so there is no membership here to take. */
  | "abroad"
  /** A worktree create is heading for the directory — on one side of the
   * question or the other. Nothing is there yet, and git makes no second
   * worktree on one path. */
  | "creating"
  /** A confirmed close is still removing the directory. */
  | "removing"
  /** The team there is being disbanded: a pane landing on it now would be
   * reaped by that close a moment later. */
  | "ending"
  /** The deck refused the write — an invariant, not a directory. */
  | "refused";

/** Max agents ONE TEAM holds at once — the message, not the cap; the cap
 * itself lives with the grid it constrains. */
export function teamFullMessage(maxPanes: number): string {
  return `The team is full — ${maxPanes} agents; close one first`;
}

/** The error when the workspace a pane was headed for is no longer in the
 * deck — every add re-resolves against the live store, and a close can land
 * inside the awaits a worktree create or a fork's surgery needs. */
export const WORKSPACE_GONE_MESSAGE = "That workspace was closed.";

/** What a refusal is called, said the same way whichever door asked. */
export function placementRefusalMessage(why: PlacementRefusal): string {
  switch (why) {
    case "abroad":
      return "That directory is another workspace's team's.";
    case "creating":
      return "A worktree is still being created there — try again in a moment.";
    case "removing":
      return "That directory is still being removed — try again in a moment.";
    case "ending":
      return "That team is being disbanded.";
    case "refused":
      return "The deck refused that placement.";
  }
}
