import { invoke } from "@tauri-apps/api/core";
import { log } from "./log";
import { errorMessage } from "@keepdeck/plugin-api";

/**
 * Taking back the MCP config files earlier builds planted in pane cwds —
 * planting is the agent's plugin's (`arm.plan`) and the cwd arming engine's
 * now; these take back only what was planted before it.
 */

/** Take KeepDeck's config back out of these cwds. Reports whether it got
 * through: a sweep must not record itself as done on a failed pass. */
export async function mcpDisarm(roots: string[]): Promise<boolean> {
  if (roots.length === 0) return true;
  try {
    await invoke("mcp_disarm", { roots });
    return true;
  } catch (e) {
    log.warn("web:mcp", `disarm failed: ${errorMessage(e)}`);
    return false;
  }
}

/** Sweep what workspaces that are gone left in their cwds. */
export async function mcpPrune(liveWsIds: string[]): Promise<boolean> {
  try {
    await invoke("mcp_prune", { liveWsIds });
    return true;
  } catch (e) {
    log.warn("web:mcp", `prune failed: ${errorMessage(e)}`);
    return false;
  }
}
