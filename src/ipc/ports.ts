import { invoke } from "@tauri-apps/api/core";

/** The base of the worktree's deterministic 10-port block (`KEEPDECK_PORT`):
 * same key → same block across restarts, occupied blocks probe forward.
 * Rejects only when the whole managed range is taken. */
export function allocatePorts(key: string): Promise<number> {
  return invoke<number>("ports_allocate", { key });
}
