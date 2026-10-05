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
 * store root, opening the task database in it) and the database itself —
 * every board in one store (keepdeck-tasks). Its wire types are generated
 * from the Rust structs (./generated/tasks); the board files are read only
 * by the move into the database.
 */

export async function tasksEnable(): Promise<void> {
  await invoke("tasks_enable");
}

export async function tasksDisable(): Promise<void> {
  await invoke("tasks_disable");
}

/** Drop a closing workspace's board — its rows and its old files.
 * Idempotent; called from workspace deletion, the one place that knows the
 * live workspace set. */
export async function tasksDropWorkspace(wsId: string): Promise<void> {
  await invoke("tasks_drop_workspace", { wsId });
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
