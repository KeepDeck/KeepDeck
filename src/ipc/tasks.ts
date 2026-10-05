import { invoke } from "@tauri-apps/api/core";
import type { Applied } from "./generated/tasks/Applied";
import type { ChangeSet } from "./generated/tasks/ChangeSet";
import type { LegacyBoard } from "./generated/tasks/LegacyBoard";
import type { MigrationSource } from "./generated/tasks/MigrationSource";
import type { SearchHit } from "./generated/tasks/SearchHit";
import type { StoreError } from "./generated/tasks/StoreError";
import type { StoreStatus } from "./generated/tasks/StoreStatus";
import type { StoredBoard } from "./generated/tasks/StoredBoard";

/**
 * The task board's Rust surface: the enable pair (claim and release the
 * store root) and the per-workspace board file, read and written WHOLE.
 * The bytes are the TS domain's board as JSON — the store keeps them, it
 * does not read them. Throws on failure; the store's sentences are written
 * for the caller's eyes.
 */

export async function tasksEnable(): Promise<void> {
  await invoke("tasks_enable");
}

export async function tasksDisable(): Promise<void> {
  await invoke("tasks_disable");
}

/** One workspace's board as stored, or null when it was never written. */
export async function tasksRead(payload: {
  workspaceId: string;
}): Promise<string | null> {
  return await invoke<string | null>("tasks_read", { payload });
}

export async function tasksWrite(payload: {
  workspaceId: string;
  json: string;
}): Promise<void> {
  await invoke("tasks_write", { payload });
}

/** Drop a closing workspace's board. Idempotent; called from workspace
 * deletion, the one place that knows the live workspace set. */
export async function tasksDropWorkspace(wsId: string): Promise<void> {
  await invoke("tasks_drop_workspace", { wsId });
}

/** Keep the board as it is now beside it as `board.<label>.json`, once —
 * what a format change takes before its first write. */
export async function tasksKeepCopy(payload: { workspaceId: string; label: string }): Promise<void> {
  await invoke("tasks_keep_copy", { payload });
}

// ── The task database (keepdeck-tasks): every board in one store ─────────
// A refusal arrives as a StoreError — a code the caller acts on (whether
// to try again, whether the database is in doubt), never a sentence.


/** Whether a thrown value is the store's coded refusal. */
export function isStoreError(value: unknown): value is StoreError {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string";
}

export async function tasksStatus(): Promise<StoreStatus> {
  return await invoke<StoreStatus>("tasks_status");
}

/** A workspace's board, or null when it has none yet. */
export async function tasksLoad(workspace: string): Promise<StoredBoard | null> {
  return await invoke<StoredBoard | null>("tasks_load", { workspace });
}

export async function tasksLoadAll(): Promise<StoredBoard[]> {
  return await invoke<StoredBoard[]>("tasks_load_all");
}

export async function tasksApply(change: ChangeSet): Promise<Applied> {
  return await invoke<Applied>("tasks_apply", { change });
}

export async function tasksSearch(query: string, boards: string[], limit: number): Promise<SearchHit[]> {
  return await invoke<SearchHit[]>("tasks_search", { query, boards, limit });
}

/** Every board file on disk, read at once — the migration's source. */
export async function tasksLegacyBoards(): Promise<LegacyBoard[]> {
  return await invoke<LegacyBoard[]>("tasks_legacy_boards");
}

export async function tasksImport(boards: StoredBoard[], sources: MigrationSource[]): Promise<void> {
  await invoke("tasks_import", { boards, sources });
}

export async function tasksMigrationSources(): Promise<MigrationSource[]> {
  return await invoke<MigrationSource[]>("tasks_migration_sources");
}

/** The database becomes the source; every board.json becomes its board.pre-db.json copy. */
export async function tasksActivateMigration(): Promise<void> {
  await invoke("tasks_activate_migration");
}

export async function tasksDiscardMigration(): Promise<void> {
  await invoke("tasks_discard_migration");
}

export async function tasksRestoreBackup(at: number): Promise<void> {
  await invoke("tasks_restore_backup", { at });
}

export async function tasksRestoreBoards(boards: StoredBoard[]): Promise<void> {
  await invoke("tasks_restore_boards", { boards });
}
