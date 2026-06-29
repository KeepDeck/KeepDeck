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

/** Mirrors the Rust `WorktreeStatus`. */
export interface WorktreeStatus {
  dirty: boolean;
  branch: string | null;
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
}

/** Is `path` inside a git repo? plus its HEAD/branch. Never throws for a
 *  non-repo — it simply reports `isRepo: false`. */
export function inspectRepo(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("worktree_inspect", { path });
}

/** Provision one agent's git worktree; returns its path + branch. */
export function createWorktree(spec: CreateWorktreeArgs): Promise<WorktreeRecord> {
  return invoke<WorktreeRecord>("worktree_create", { spec });
}

/** Dirty state + branch of the worktree at `path`. */
export function worktreeStatus(path: string): Promise<WorktreeStatus> {
  return invoke<WorktreeStatus>("worktree_status", { path });
}

/** Remove an agent's worktree. Refuses a dirty worktree unless `force`, so work
 *  is never destroyed by default. */
export function removeWorktree(
  repo: string,
  path: string,
  force = false,
): Promise<void> {
  return invoke("worktree_remove", { spec: { repo, path, force } });
}
