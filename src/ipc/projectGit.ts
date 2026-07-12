import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { GitChangedFile, GitHistory, GitStatus } from "@keepdeck/plugin-api";

/**
 * The backend behind the plugin `git` service (`services.git`). Read-only git
 * state of the user's PROJECT repositories — the git sibling of
 * `ipc/projectFs.ts`, with the identical scope contract: `roots` are the
 * folders the caller's scope authorizes, and the Rust side enforces that the
 * repo path is contained within one of them unless `everywhere` waives the
 * check. See `src-tauri/src/project_git.rs`.
 */

/** One repo's working-tree status. Rejects a path outside `roots` when not
 * `everywhere`. */
export function projectGitStatus(
  path: string,
  roots: string[],
  everywhere: boolean,
): Promise<GitStatus> {
  return invoke<GitStatus>("project_git_status", { path, roots, everywhere });
}

/** Unified diff text for one tracked repo-relative path — worktree vs index,
 * or index vs HEAD when `staged`. */
export function projectGitDiffFile(
  path: string,
  roots: string[],
  everywhere: boolean,
  file: string,
  staged: boolean,
  from?: string,
  to?: string,
): Promise<string> {
  return invoke<string>("project_git_diff_file", {
    path,
    roots,
    everywhere,
    file,
    staged,
    from: from ?? null,
    to: to ?? null,
  });
}

/** The repo's history since its fork point off `base` (or the default
 * branch); plain recent history when no fork applies. */
export function projectGitHistory(
  path: string,
  roots: string[],
  everywhere: boolean,
  base?: string,
): Promise<GitHistory> {
  return invoke<GitHistory>("project_git_history", {
    path,
    roots,
    everywhere,
    base: base ?? null,
  });
}

/** The paths changed across `from..to`, or `from` vs the working tree. */
export function projectGitChangedFiles(
  path: string,
  roots: string[],
  everywhere: boolean,
  from: string,
  to?: string,
): Promise<GitChangedFile[]> {
  return invoke<GitChangedFile[]>("project_git_changed_files", {
    path,
    roots,
    everywhere,
    from,
    to: to ?? null,
  });
}

/** The Tauri event a repo watcher emits when its status may have changed.
 * Mirrors PROJECT_GIT_CHANGE_EVENT in src-tauri/src/project_git.rs. */
export const PROJECT_GIT_CHANGE_EVENT = "deck://project-git/change";

/** Start watching one repo for status-relevant changes (scoped by `roots`
 * unless `everywhere`). Idempotent per path; changes arrive via
 * {@link onProjectGitChange}. */
export function projectGitWatch(
  path: string,
  roots: string[],
  everywhere: boolean,
): Promise<void> {
  return invoke("project_git_watch", { path, roots, everywhere });
}

/** Stop watching a repo. */
export function projectGitUnwatch(path: string): Promise<void> {
  return invoke("project_git_unwatch", { path });
}

/** Subscribe to repo-change events; the handler receives the watched path
 * exactly as registered. Resolves to the unlisten function. */
export function onProjectGitChange(
  handler: (path: string) => void,
): Promise<() => void> {
  return listen<{ path: string }>(PROJECT_GIT_CHANGE_EVENT, (event) =>
    handler(event.payload.path),
  );
}
