import type { FsFile, GitDiffOptions } from "@keepdeck/plugin-api";
import type { ChangeRow } from "./status";
import type { GitRange } from "./history";
import { binaryFileDiff, newFileDiff, type DiffNote, type FileDiff } from "./diff";

/**
 * Where a row's diff is READ from — the rule; the peek only executes it.
 *
 * Two sources. The working FILE, for a row git has no two-sided diff for:
 * an untracked file has nothing to compare against, and an unmerged one
 * prints as a combined diff (`@@@`, two marker columns) that a two-sided
 * parser garbles — the file with its conflict markers is what the reader
 * needs. A file-shaped row reads the file whatever change set it sits in:
 * an untracked file in a since-fork sweep has no diff at any range either.
 * `git diff` for everything else: across the drilled range for a History
 * row, index-vs-HEAD or worktree-vs-index for a worktree row by its section.
 */
export type DiffRead =
  | { source: "file"; path: string; as: "untracked" | "conflicted" }
  | { source: "git"; options: GitDiffOptions };

export function diffReadFor(
  repo: string,
  row: ChangeRow,
  range: GitRange | undefined,
): DiffRead {
  if (row.kind === "untracked" || row.kind === "conflicted") {
    return { source: "file", path: filePath(repo, row.path), as: row.kind };
  }
  // The old path rides along only when the row has one: with it git pairs
  // the rename and shows the edit, without it the new path reads as a whole
  // new file. Absent (not `undefined`) when there is none, so a row without
  // a rename asks for exactly what it always asked for.
  const renamed = row.origPath ? { origPath: row.origPath } : {};
  return {
    source: "git",
    options: range
      ? { from: range.from, to: range.to, ...renamed }
      : { staged: row.kind === "staged", ...renamed },
  };
}

/** A read of the working file, as the diff a file-shaped row shows: the
 * content all-added — an untracked file plainly, an unmerged one under its
 * note — or the binary marker when there is no text, the note kept: a
 * binary file in conflict is still in conflict. `truncated` is the read's
 * own flag; the host caps a file read as it caps a diff. */
export function fileAsDiff(
  as: "untracked" | "conflicted",
  file: Pick<FsFile, "text" | "isBinary" | "truncated">,
): FileDiff {
  const notes: DiffNote[] = as === "conflicted" ? [{ kind: "unmerged" }] : [];
  const diff =
    file.isBinary || file.text === null
      ? binaryFileDiff()
      : newFileDiff(file.text, file.truncated);
  return { ...diff, notes };
}

/** The file's absolute path under the repo, one separator between. */
function filePath(repo: string, path: string): string {
  return `${repo.replace(/\/+$/, "")}/${path}`;
}
