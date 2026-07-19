import { invoke } from "@tauri-apps/api/core";

/**
 * The `fsWrite` capability's backend ([F8] session-store surgery): narrow
 * write primitives containment-checked in Rust against the manifest-declared
 * prefixes the host passes with every call. A leading `~/` in either the
 * path or a prefix expands to the user's home on the Rust side.
 */

export function pluginsFsWriteMkdir(
  path: string,
  roots: readonly string[],
): Promise<void> {
  return invoke("plugins_fs_write_mkdir", { path, roots });
}

export function pluginsFsWriteCopy(
  src: string,
  dst: string,
  roots: readonly string[],
): Promise<void> {
  return invoke("plugins_fs_write_copy", { src, dst, roots });
}

export function pluginsFsWriteFile(
  path: string,
  text: string,
  roots: readonly string[],
): Promise<void> {
  return invoke("plugins_fs_write_file", { path, text, roots });
}

export function pluginsFsWriteAppend(
  path: string,
  line: string,
  roots: readonly string[],
): Promise<void> {
  return invoke("plugins_fs_write_append", { path, line, roots });
}
