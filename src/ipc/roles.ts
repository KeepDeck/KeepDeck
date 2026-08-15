import { invoke } from "@tauri-apps/api/core";

/** One stored role file (mirrors the Rust `RoleFileDto`): the id its file
 * NAME carries, and raw JSON content — parsed and judged by the domain
 * (`mergeRoleCatalog`), never here. */
export interface StoredRoleFile {
  id: string;
  content: string;
}

/** The raw library read — THROWS on a backend error, so the manager can
 * keep its last good catalog rather than install an empty lie. */
export async function fetchRoleFiles(): Promise<StoredRoleFile[]> {
  return await invoke<StoredRoleFile[]>("roles_list");
}

/** Write one role's file. Throws on failure — a save the user asked for
 * must not silently vanish. */
export async function saveRoleFile(id: string, content: string): Promise<void> {
  await invoke("roles_save", { id, content });
}

/** Remove one role's file; missing is the outcome asked for. Throws on a
 * real failure. */
export async function deleteRoleFile(id: string): Promise<void> {
  await invoke("roles_delete", { id });
}
