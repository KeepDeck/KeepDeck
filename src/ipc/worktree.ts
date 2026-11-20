import type { RepoCheckout } from "../domain/deck";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PathProbe } from "../domain/agents";

/** Mirrors the Rust `RepoInfo` (camelCase). */
export interface RepoInfo {
  isRepo: boolean;
  head: string | null;
  branch: string | null;
}

/** Is `path` inside a git repo? plus its HEAD/branch. Never throws for a
 *  non-repo — it simply reports `isRepo: false`. */
export function inspectRepo(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("worktree_inspect", { path });
}

/** Probe a candidate worktree path (exists? a worktree? which branch?) to drive
 *  the agent dialog's live hint ([F2]). Never throws — an unusable path reports
 *  `exists: false`. Shape mirrors the Rust `PathProbe` ([`PathProbe`]). */
export function probeWorktree(path: string): Promise<PathProbe> {
  return invoke<PathProbe>("worktree_probe", { path });
}

/** The repo's local branch names — the options behind the agent dialog's
 *  base-branch picker. The likeliest base leads (the repo's default branch,
 *  else the checked-out one), the rest alphabetical. Rejects when `repo` isn't
 *  a git repo or git fails; callers flatten that to "no list", which relaxes
 *  base validation instead of blocking the dialog. */
export function listBranches(repo: string): Promise<string[]> {
  return invoke<string[]>("worktree_branches", { repo });
}

/** Every checkout of `repo`, with the uncommitted work each holds. */
export function listWorktrees(repo: string): Promise<RepoCheckout[]> {
  return invoke<RepoCheckout[]>("worktree_list", { repo });
}

/**
 * HEAD-change events (live branch badge). The Rust watcher over a registered
 * worktree's gitdir emits one whenever a checkout inside that worktree moves
 * its HEAD — and once immediately at registration, which is what reconciles a
 * stale persisted branch on boot. Mirrors `WORKTREE_HEAD_EVENT` in
 * src-tauri/src/head_watch.rs.
 */
export const WORKTREE_HEAD_EVENT = "deck://worktree/head";

/** Mirrors the Rust `HeadEvent` (camelCase): on a branch, or detached at a
 *  commit. `path` is the worktree path exactly as registered — the pane key. */
export interface WorktreeHead {
  path: string;
  branch: string | null;
  head: string | null;
}

/** Subscribe to worktree HEAD changes; resolves to the unlisten function. */
export function onWorktreeHead(
  handler: (head: WorktreeHead) => void,
): Promise<() => void> {
  return listen<WorktreeHead>(WORKTREE_HEAD_EVENT, (event) =>
    handler(event.payload),
  );
}

/** Start watching a worktree's HEAD (idempotent per path). Rejects when the
 *  path isn't a git worktree — e.g. its directory is gone. */
export function watchWorktree(path: string): Promise<void> {
  return invoke("worktree_watch", { path });
}

/** Stop watching a worktree's HEAD (pane closed / workspace gone). */
export function unwatchWorktree(path: string): Promise<void> {
  return invoke("worktree_unwatch", { path });
}
