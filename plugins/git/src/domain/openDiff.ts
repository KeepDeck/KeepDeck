import type { WorkspaceRef } from "@keepdeck/plugin-api";
import type { ChangeRow } from "./status";
import type { HistoryScope } from "./history";

/**
 * The open diff as a value, and the rules that move it: what a gesture
 * opens, which row it shows, and when a deck event takes it off the screen.
 * No React — the resident overlay holds one of these in state and applies
 * these to it.
 */

/** The two open gestures. History carries no row: a scope opens BEFORE any
 * file is picked and the peek's rail seeds the first one, which is why the
 * open diff — not the request — owns the current row.
 *
 * `workspace` is the one the gesture was made in. The peek outlives the dock
 * but must not outlive its subject: without this the diff had no way to know
 * the user had walked away to another workspace, and stayed on screen over
 * it. */
export type PeekRequest = { repo: string; workspace: WorkspaceRef } & (
  | { kind: "worktree"; row: ChangeRow }
  | { kind: "history"; scope: HistoryScope }
);

/** Splitting the union keeps a null-row worktree unrepresentable: a Changes
 * row is always picked before it opens, while a History scope opens first
 * and the peek's rail seeds its file after. `repo` is the diff's OWN —
 * captured when it was opened, not read from the tab. */
export type OpenDiff = { repo: string; workspace: WorkspaceRef } & (
  | { kind: "worktree"; row: ChangeRow }
  | { kind: "history"; row: ChangeRow | null; scope: HistoryScope }
);

/** What a gesture opens: a Changes row on itself, a History scope with no
 * file yet. */
export function openDiffFor(request: PeekRequest): OpenDiff {
  const { repo, workspace } = request;
  return request.kind === "worktree"
    ? { repo, workspace, kind: "worktree", row: request.row }
    : { repo, workspace, kind: "history", row: null, scope: request.scope };
}

/** The same diff on another row of its change set. */
export function withRow(diff: OpenDiff, row: ChangeRow): OpenDiff {
  return { ...diff, row };
}

/** The diff after the deck put `active` in front. The selection event fires
 * for the ACTIVE workspace, so a different one named here means the user
 * moved: a diff of the workspace they left comes down. A selection within
 * its own workspace — clicking a pane — must not shut a diff being read. */
export function afterSelection(diff: OpenDiff, active: WorkspaceRef): OpenDiff | null {
  return sameWorkspace(diff, active) ? diff : null;
}

/** The diff after `closed` went away: its own diff goes with it, another
 * workspace's closing is none of its business. */
export function afterClose(diff: OpenDiff, closed: WorkspaceRef): OpenDiff | null {
  return sameWorkspace(diff, closed) ? null : diff;
}

/** By instance: a workspace reopened under the same id is another one. */
function sameWorkspace(diff: OpenDiff, workspace: WorkspaceRef): boolean {
  return diff.workspace.instance === workspace.instance;
}
