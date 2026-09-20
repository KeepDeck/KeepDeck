import { invoke } from "@tauri-apps/api/core";

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
