import { invoke } from "@tauri-apps/api/core";

/**
 * The `fsWrite` capability's backend ([F8] session-store surgery): narrow
 * write primitives for one plugin, containment-checked in Rust against that
 * plugin's own roots — its declared prefixes and the workspace directories
 * it was handed, looked up natively by its id. A leading `~/` in a path
 * expands to the user's home on the Rust side.
 */

export function pluginsFsWriteMkdir(pluginId: string, path: string): Promise<void> {
  return invoke("plugins_fs_write_mkdir", { pluginId, path });
}

export function pluginsFsWriteCopy(
  pluginId: string,
  src: string,
  dst: string,
  replace?: readonly (readonly [string, string])[],
): Promise<void> {
  return invoke("plugins_fs_write_copy", {
    pluginId,
    src,
    dst,
    replace: replace && replace.length > 0 ? replace : null,
  });
}

export function pluginsFsWriteRemove(pluginId: string, path: string): Promise<void> {
  return invoke("plugins_fs_write_remove", { pluginId, path });
}

export function pluginsFsWriteFile(pluginId: string, path: string, text: string): Promise<void> {
  return invoke("plugins_fs_write_file", { pluginId, path, text });
}

export function pluginsFsWriteMove(pluginId: string, src: string, dst: string): Promise<void> {
  return invoke("plugins_fs_write_move", { pluginId, src, dst });
}

/** The source may also be a staged skills view — the one place outside its
 * own roots a plugin may copy from. */
export function pluginsFsWriteCopyDir(pluginId: string, src: string, dst: string): Promise<void> {
  return invoke("plugins_fs_write_copy_dir", { pluginId, src, dst });
}

export function pluginsFsWriteAppend(pluginId: string, path: string, line: string): Promise<void> {
  return invoke("plugins_fs_write_append", { pluginId, path, line });
}
