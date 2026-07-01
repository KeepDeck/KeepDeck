import { invoke } from "@tauri-apps/api/core";

/** Mirrors the Rust `RepoInfo` (camelCase). */
export interface RepoInfo {
  isRepo: boolean;
  head: string | null;
  branch: string | null;
}

/** Mirrors the Rust `WorktreeRecord`. */
export interface WorktreeRecord {
  agentId: string;
  path: string;
  branch: string;
}

/** Mirrors the Rust `WorktreeSuggestion`. */
export interface WorktreeSuggestion {
  branch: string;
  folder: string;
}

/** Args for `worktree_create` (mirrors the Rust `CreateSpec`). */
export interface CreateWorktreeArgs {
  repo: string;
  baseDir: string;
  agentId: string;
  /** Explicit branch; auto-generated (`kd/<ws>/<n>`) when omitted/blank. */
  branch?: string | null;
  /** Pinned base commit/rev; defaults to HEAD resolved at create time. */
  base?: string | null;
  workspace?: string;
  index?: number;
  /** Explicit worktree folder (relative to baseDir); derived from branch when omitted. */
  dir?: string | null;
}

/** Is `path` inside a git repo? plus its HEAD/branch. Never throws for a
 *  non-repo — it simply reports `isRepo: false`. */
export function inspectRepo(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("worktree_inspect", { path });
}

/** Default branch + folder for the index-th agent of a worktree-mode workspace
 *  (the single source of branch/folder naming, shared with the dialog). */
export function suggestWorktree(
  workspace: string,
  index: number,
): Promise<WorktreeSuggestion> {
  return invoke<WorktreeSuggestion>("worktree_suggest", { workspace, index });
}

/** Provision one agent's git worktree; returns its path + branch. */
export function createWorktree(spec: CreateWorktreeArgs): Promise<WorktreeRecord> {
  return invoke<WorktreeRecord>("worktree_create", { spec });
}

/** Options for {@link removeWorktree}. */
export interface RemoveWorktreeOptions {
  /** Remove even a dirty worktree and force-delete the branch (`git branch -D`).
   *  Refuses a dirty worktree when false, so work is never destroyed by default. */
  force?: boolean;
  /** Also delete this branch once the worktree is gone; left intact when unset. */
  branch?: string | null;
}

/** Remove an agent's worktree, and — when `branch` is given — delete that branch
 *  too (it can only be deleted after its worktree is removed). */
export function removeWorktree(
  repo: string,
  path: string,
  opts: RemoveWorktreeOptions = {},
): Promise<void> {
  return invoke("worktree_remove", {
    spec: { repo, path, force: opts.force ?? false, branch: opts.branch ?? null },
  });
}
