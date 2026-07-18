import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PathProbe } from "../domain/agents";

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
  /** Base commit/rev — a branch NAME is fine: the Rust side ALWAYS resolves
   *  it to a commit sha at create time (defaults to HEAD), pinning the batch
   *  to one commit and giving the born branch a sha-sourced creation reflog,
   *  which branch provenance trusts at close-time reaping. */
  base?: string | null;
  workspace?: string;
  index?: number;
  /** Explicit worktree folder (relative to baseDir); derived from branch when omitted. */
  dir?: string | null;
  /** Exact worktree path ([F2]). When set, the worktree is created AT this path
   *  verbatim (no collision suffix); baseDir/dir are ignored. */
  path?: string | null;
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

/** Probe a candidate worktree path (exists? a worktree? which branch?) to drive
 *  the agent dialog's live hint ([F2]). Never throws — an unusable path reports
 *  `exists: false`. Shape mirrors the Rust `PathProbe` ([`PathProbe`]). */
export function probeWorktree(path: string): Promise<PathProbe> {
  return invoke<PathProbe>("worktree_probe", { path });
}

/** The repo's local branch names — the options behind the "+ Agent" dialog's
 *  base-branch picker. The likeliest base leads (the repo's default branch,
 *  else the checked-out one), the rest alphabetical. Rejects when `repo` isn't
 *  a git repo or git fails; callers flatten that to "no list", which relaxes
 *  base validation instead of blocking the dialog. */
export function listBranches(repo: string): Promise<string[]> {
  return invoke<string[]>("worktree_branches", { repo });
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
  /** Also delete every branch CREATED inside the worktree (reflog provenance,
   *  resolved on the Rust side): the agent's side branches go with it. A created
   *  branch since checked out in another worktree is in use and is kept. */
  reapCreatedBranches?: boolean;
}

/** Remove an agent's worktree, and — when `branch` is given — delete that branch
 *  too (it can only be deleted after its worktree is removed). */
export function removeWorktree(
  repo: string,
  path: string,
  opts: RemoveWorktreeOptions = {},
): Promise<void> {
  return invoke("worktree_remove", {
    spec: {
      repo,
      path,
      force: opts.force ?? false,
      branch: opts.branch ?? null,
      reapCreatedBranches: opts.reapCreatedBranches ?? false,
    },
  });
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
