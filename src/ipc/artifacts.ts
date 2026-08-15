import { invoke } from "@tauri-apps/api/core";

/**
 * The artifacts feature's enable pair — the store root's claim and the
 * display server ride together (mirror of the MCP transport's own pair in
 * `ipc/mcp.ts`). Throws on failure — the policy layer decides how loudly
 * to react, and a contention refusal ("owned by another KeepDeck
 * process") is exactly the failure the toggle must surface.
 */

/** Claim the artifacts store root and start the display server
 * (idempotent). Resolves to the display server's port. */
export async function artifactsEnable(): Promise<number> {
  return await invoke<number>("artifacts_enable");
}

/** Tear the display server down (bye to open pages) and release the
 * store claim. Idempotent. */
export async function artifactsDisable(): Promise<void> {
  await invoke("artifacts_disable");
}
