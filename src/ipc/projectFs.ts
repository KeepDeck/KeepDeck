import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FsEntry, FsFile } from "@keepdeck/plugin-api";

/**
 * The backend behind the plugin `fs` service (`services.fs`). Reads the user's
 * PROJECT files — distinct from `ipc/plugins.ts`, which serves a plugin's own
 * bundle. `roots` are the folders the caller's fs scope authorizes (the host
 * resolves them from live deck state); the Rust side enforces that `path` is
 * contained within one of them unless `everywhere` waives the check. See
 * `src-tauri/src/project_fs.rs`.
 */

/** One directory's immediate children (lazy, non-recursive). Rejects a path
 * outside `roots` when not `everywhere`. */
export function projectFsReadDir(
  path: string,
  roots: string[],
  everywhere: boolean,
): Promise<FsEntry[]> {
  return invoke<FsEntry[]>("project_fs_read_dir", { path, roots, everywhere });
}

/** One file's contents (UTF-8 text, or flagged binary), capped at `maxBytes`
 * (the Rust side clamps to its own ceiling; `null` = the default cap). */
export function projectFsReadFile(
  path: string,
  roots: string[],
  everywhere: boolean,
  maxBytes?: number,
): Promise<FsFile> {
  return invoke<FsFile>("project_fs_read_file", {
    path,
    roots,
    everywhere,
    maxBytes: maxBytes ?? null,
  });
}

/** The Tauri event a directory watcher emits when its listing changes. Mirrors
 * PROJECT_FS_CHANGE_EVENT in src-tauri/src/project_fs.rs. */
export const PROJECT_FS_CHANGE_EVENT = "deck://project-fs/change";

/** Start watching one directory for entry changes (scoped by `roots` unless
 * `everywhere`). Idempotent per path; changes arrive via {@link onProjectFsChange}. */
export function projectFsWatch(
  path: string,
  roots: string[],
  everywhere: boolean,
): Promise<void> {
  return invoke("project_fs_watch", { path, roots, everywhere });
}

/** Stop watching a directory. */
export function projectFsUnwatch(path: string): Promise<void> {
  return invoke("project_fs_unwatch", { path });
}

/** Subscribe to directory-change events; the handler receives the watched path
 * exactly as registered. Resolves to the unlisten function. */
export function onProjectFsChange(
  handler: (path: string) => void,
): Promise<() => void> {
  return listen<{ path: string }>(PROJECT_FS_CHANGE_EVENT, (event) =>
    handler(event.payload.path),
  );
}
