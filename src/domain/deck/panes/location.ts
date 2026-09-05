/**
 * Where a pane runs — as ONE answer.
 *
 * A pane records its placement in four optional fields (`cwd`, `branch`,
 * `remoteEndpoint`, `provisioning`), and nothing in that shape says which
 * combinations mean something. A card beside a directory, an endpoint beside
 * a directory — both type-check, and the invariant that keeps them apart is
 * enforced by the order in which transforms write and by a guard at each
 * consumer. The "+ Agent" request already arrives as a proper union of four
 * shapes; the factory unfolds it into the fields, and every reader folds it
 * back by hand.
 *
 * This is the fold, done once. Readers ask [`locationOf`] and match on
 * `kind`; a combination the fields allow but the meaning does not is settled
 * here by ONE rule, written down, rather than by whichever consumer happened
 * to look first.
 */
import type { Pane, PaneProvisioning } from "./model";

export type PaneLocation =
  /** No directory of its own: the pane runs in the workspace cwd. `branch`
   * is the branch the root checkout was on when this pane's session was
   * recorded — a resumed session carries it — and nothing owns it: it names
   * where the work was, not a worktree to clean up. */
  | { kind: "main"; branch?: string }
  /** A directory the pane owns or was attached to. `branch` is the worktree
   * branch when one was created or named; a pane attached to a detached
   * checkout, or resumed from a session that recorded only a directory, has
   * none — and no consumer tells those two apart. */
  | { kind: "attached"; cwd: string; branch?: string }
  /** The worktree is still being created (or the create failed and waits for
   * Retry). The card is the whole intent plus its runtime status. */
  | { kind: "provisioning"; card: PaneProvisioning }
  /** The agent runs on another machine; the local terminal is a thin client.
   * A local directory would be meaningless, so none is carried. */
  | { kind: "remote"; endpoint: string };

/** The fields [`locationOf`] reads — the four the union replaces. */
export type PanePlacementFields = Pick<
  Pane,
  "cwd" | "branch" | "remoteEndpoint" | "provisioning"
>;

/**
 * Fold a pane's placement fields into its location.
 *
 * The rule, in order of precedence:
 *
 *  1. A truthy `remoteEndpoint` makes the pane remote, whatever else is set —
 *     "the local location is moot", as the factory puts it. Truthy rather
 *     than present, matching the predicate this replaces: an empty endpoint
 *     is the non-remote degenerate case.
 *  2. A `cwd` makes the pane attached. A provisioning card beside it is
 *     dropped: the resolve transition writes the directory and removes the
 *     card in one step, so the pair only ever reaches this from a hand-edited
 *     document, and "the create landed" is the reading that leaves the user
 *     with a terminal rather than a card whose Retry would collide with the
 *     directory that exists.
 *  3. A card with no directory is a pane still provisioning.
 *  4. Anything else runs in the workspace cwd, keeping a `branch` if one is
 *     recorded: a session resumed from the workspace root arrives with the
 *     branch it ran on and no directory, and surfaces still name it.
 */
/** The worktree an attached pane runs in, or null for any other placement.
 * The projection five app-layer readers want — "the pane's own directory,
 * if it has one" — so none of them spells the match out. */
export function attachedWorktree(
  pane: PanePlacementFields,
): { cwd: string; branch?: string } | null {
  const location = locationOf(pane);
  return location.kind === "attached" ? location : null;
}

/** The create card of a provisioning pane, or null for any other placement —
 * what a surface that draws the card asks, in the shape its prop takes. */
export function provisioningCard(pane: PanePlacementFields): PaneProvisioning | null {
  const location = locationOf(pane);
  return location.kind === "provisioning" ? location.card : null;
}

export function locationOf(pane: PanePlacementFields): PaneLocation {
  if (pane.remoteEndpoint) return { kind: "remote", endpoint: pane.remoteEndpoint };
  if (pane.cwd !== undefined) {
    return pane.branch !== undefined
      ? { kind: "attached", cwd: pane.cwd, branch: pane.branch }
      : { kind: "attached", cwd: pane.cwd };
  }
  if (pane.provisioning) return { kind: "provisioning", card: pane.provisioning };
  return pane.branch !== undefined
    ? { kind: "main", branch: pane.branch }
    : { kind: "main" };
}

/** The branch a pane's work is on, whether it owns a worktree for it or
 * recorded it from the workspace root — or nothing, for a pane whose create
 * is in flight or whose agent runs elsewhere. */
export function paneBranch(pane: PanePlacementFields): string | undefined {
  const location = locationOf(pane);
  switch (location.kind) {
    case "main":
    case "attached":
      return location.branch;
    case "provisioning":
    case "remote":
      return undefined;
  }
}
