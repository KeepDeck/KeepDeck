import type { GitStatus, GitStatusEntry } from "@keepdeck/plugin-api";

/**
 * Pure presentation model over a `GitStatus` — how raw porcelain entries
 * become the tab's sections. No React, no services: fully unit-testable.
 */

/** Which section a row belongs to — also decides which diff it opens
 * (`staged` peeks index-vs-HEAD, `unstaged` peeks worktree-vs-index,
 * `untracked` renders the file's plain content as all-new, `history` diffs
 * across the History view's drilled revision range). */
export type ChangeKind =
  | "conflicted"
  | "staged"
  | "unstaged"
  | "untracked"
  | "history";

/** One row in a section. A path staged AND edited again appears twice — once
 * under Staged, once under Changes — because those are two different diffs
 * (the VS Code model). */
export interface ChangeRow {
  /** Repo-relative path. */
  path: string;
  /** The pre-rename path, when the index stages a rename. */
  origPath: string | null;
  /** The porcelain v2 code for THIS row's side (`M`, `A`, `D`, `R`, …); a
   * conflicted row carries both sides (`UU`, `AA`, `DU`, …), which is what
   * tells "both added" from "both deleted" without opening the file. */
  code: string;
  kind: ChangeKind;
}

export interface ChangeGroups {
  conflicted: ChangeRow[];
  staged: ChangeRow[];
  unstaged: ChangeRow[];
  untracked: ChangeRow[];
  /** Distinct changed paths (an entry in two sections counts once). */
  total: number;
}

/** Split status entries into the tab's sections, keeping git's own order
 * within each. */
export function groupEntries(entries: GitStatusEntry[]): ChangeGroups {
  const groups: ChangeGroups = {
    conflicted: [],
    staged: [],
    unstaged: [],
    untracked: [],
    total: entries.length,
  };
  for (const entry of entries) {
    if (entry.conflicted) {
      groups.conflicted.push(row(entry, `${entry.staged}${entry.unstaged}`, "conflicted"));
      continue;
    }
    if (entry.untracked) {
      groups.untracked.push(row(entry, "?", "untracked"));
      continue;
    }
    if (entry.staged !== ".") {
      groups.staged.push(row(entry, entry.staged, "staged"));
    }
    if (entry.unstaged !== ".") {
      groups.unstaged.push(row(entry, entry.unstaged, "unstaged"));
    }
  }
  return groups;
}

function row(entry: GitStatusEntry, code: string, kind: ChangeKind): ChangeRow {
  return { path: entry.path, origPath: entry.origPath, code, kind };
}

/** Where an open row stands after a status refresh. Itself, fresh, while
 * its section still lists the path; the same path's row in another section
 * when the change MOVED — staged with `git add`, unstaged by a reset, a
 * conflict resolved, an untracked file added — so the open peek follows
 * the file to the diff it now has instead of re-reading the one it no
 * longer has; itself unchanged when the path left the status altogether,
 * where the diff then reads empty, which is the truth. */
export function reconcileRow(row: ChangeRow, groups: ChangeGroups): ChangeRow {
  const listed = [
    ...groups.conflicted,
    ...groups.staged,
    ...groups.unstaged,
    ...groups.untracked,
  ].filter((candidate) => candidate.path === row.path);
  return listed.find((candidate) => candidate.kind === row.kind) ?? listed[0] ?? row;
}

/** A porcelain code in plain words — row tooltips and accessibility labels.
 * A conflict's two sides say who did what (git's own `status` wording). */
export function codeLabel(code: string): string {
  switch (code) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type changed";
    case "U":
      return "conflicted";
    case "UU":
      return "both modified";
    case "AA":
      return "both added";
    case "DD":
      return "both deleted";
    case "AU":
      return "added by us";
    case "UA":
      return "added by them";
    case "DU":
      return "deleted by us";
    case "UD":
      return "deleted by them";
    case "?":
      return "untracked";
    default:
      return "changed";
  }
}

/** What to print as "where HEAD is": the branch, or the detached commit's
 * short sha, or the unborn-branch fallback. */
export function headline(status: GitStatus): string {
  if (status.branch) return status.branch;
  if (status.detached && status.oid) return `${status.oid.slice(0, 7)} (detached)`;
  return "(no commits yet)";
}

/** The path's directory part (empty for a root-level file). */
export function dirName(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at + 1);
}

/** The path's file name. */
export function baseName(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}
