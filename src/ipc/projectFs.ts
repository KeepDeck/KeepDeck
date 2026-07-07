import { invoke } from "@tauri-apps/api/core";
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
