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

/**
 * Where each SIDE of a row's diff is read from whole — for a reader that needs
 * the lines between the hunks (the highlighter: a comment or string opened in
 * a gap decides how the next hunk reads). The rule; the peek executes it.
 *
 * `git` reads the stored file at `rev`, or in the index when `rev` is absent;
 * `file` reads the working file. A side that turns out not to exist (an added
 * file's old side, a deleted file's new one) reads as absent — no rule here
 * guesses that from the row's code.
 *
 * - An untracked or unmerged row shows the working file itself: its diff IS
 *   the whole file, so there is no side to add.
 * - A range: its `from` against its `to`, or against the working tree when
 *   the range is open (everything since the fork, uncommitted work too).
 * - A staged row: HEAD against the index.
 * - An unstaged row: the index against the working file, BOTH under the
 *   row's current name — a rename staged before the edit is already the
 *   index's, so the old path names nothing there.
 */
export type SideRead =
  | { source: "git"; path: string; rev?: string }
  | { source: "file"; path: string };

export interface DiffSides {
  old: SideRead | null;
  new: SideRead | null;
}

export function diffSidesFor(
  repo: string,
  row: ChangeRow,
  range: GitRange | undefined,
): DiffSides {
  if (row.kind === "untracked" || row.kind === "conflicted") {
    return { old: null, new: null };
  }
  const working: SideRead = { source: "file", path: filePath(repo, row.path) };
  const before = row.origPath ?? row.path;
  if (range) {
    return {
      old: { source: "git", path: before, rev: range.from },
      new: range.to === undefined ? working : { source: "git", path: row.path, rev: range.to },
    };
  }
  if (row.kind === "staged") {
    return {
      old: { source: "git", path: before, rev: "HEAD" },
      new: { source: "git", path: row.path },
    };
  }
  return { old: { source: "git", path: row.path }, new: working };
}

/** What a side read gives the highlighter: its text, or none for a side that
 * is not there or is not text. A cut-short side still counts — its lines are
 * whole up to the cap, and a line past it simply finds nothing to match. */
export function sideText(read: { text: string | null; isBinary: boolean } | null): string | null {
  return read === null || read.isBinary ? null : read.text;
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
