import type { GitStatus, GitStatusEntry } from "@keepdeck/plugin-api";

/**
 * Pure presentation model over a `GitStatus` — how raw porcelain entries
 * become the tab's sections. No React, no services: fully unit-testable.
 */

/** Which section a row belongs to — also decides which diff it opens
 * (`staged` peeks index-vs-HEAD, `unstaged` peeks worktree-vs-index,
 * `untracked` renders the file's plain content as all-new). */
export type ChangeKind = "conflicted" | "staged" | "unstaged" | "untracked";

/** One row in a section. A path staged AND edited again appears twice — once
 * under Staged, once under Changes — because those are two different diffs
 * (the VS Code model). */
export interface ChangeRow {
  /** Repo-relative path. */
  path: string;
  /** The pre-rename path, when the index stages a rename. */
  origPath: string | null;
  /** The porcelain v2 code for THIS row's side (`M`, `A`, `D`, `R`, …). */
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
      groups.conflicted.push(row(entry, "U", "conflicted"));
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

/** A porcelain code in plain words — row tooltips and accessibility labels. */
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
