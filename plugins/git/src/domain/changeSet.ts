import type { GitChangedFile } from "@keepdeck/plugin-api";
import type { ChangeGroups, ChangeRow } from "./status";
import { historyRow, type HistoryScope } from "./history";

/**
 * The change set an open diff belongs to — what its rail lists and what the
 * arrows walk. A union, not optional fields: a worktree diff belongs to the
 * LIVE status groups, a History diff to one drilled scope; never both.
 *
 * `error` carries the status feed's own failure. A peek can outlive the
 * worktree it opened on (closing the pane deletes it), and the rail is where
 * that has to be said — silently dropping the list left the reader looking at
 * hunks of a directory that no longer exists.
 */
export type ChangeSet =
  | { kind: "worktree"; groups: ChangeGroups | null; error: string | null }
  | { kind: "history"; scope: HistoryScope };

/** The change set's rows in order — the rail's list, and the path the
 * arrows walk. A worktree set lists the live groups in section order; a
 * History set its files, each as a peek row. Nothing until the groups or
 * the files have loaded. */
export function changeSetRows(
  changeSet: ChangeSet,
  files: GitChangedFile[] | null,
): ChangeRow[] {
  if (changeSet.kind === "worktree") {
    const groups = changeSet.groups;
    return groups
      ? [...groups.conflicted, ...groups.staged, ...groups.unstaged, ...groups.untracked]
      : [];
  }
  return (files ?? []).map(historyRow);
}

/** The row a History scope opens on: the first of its files, once they have
 * loaded and while no row is chosen — a scope opens before any file is
 * picked, and the peek should show a diff at once. A worktree diff always
 * opens on a chosen row, and never seeds. */
export function seedRow(
  kind: ChangeSet["kind"],
  current: ChangeRow | null,
  files: GitChangedFile[] | null,
): ChangeRow | null {
  if (kind !== "history" || current || !files || files.length === 0) return null;
  return historyRow(files[0]);
}
