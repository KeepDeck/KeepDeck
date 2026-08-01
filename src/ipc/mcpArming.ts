import { invoke } from "@tauri-apps/api/core";
import { describeError, log } from "./log";

/** One pane cwd and the MCP config it should carry. */
export interface McpArmEntry {
  root: string;
  content: string;
}

/** What one arming pass did, and where it refused. A refusal is a directory
 * whose `.kimi-code/mcp.json` belongs to the user — the app names those panes
 * rather than leaving them silently without servers. */
export interface McpArmReport {
  armed: string[];
  refused: { root: string; reason: string }[];
}

const NOTHING: McpArmReport = { armed: [], refused: [] };

/** Plant the config in each cwd. A backend failure degrades to "nothing was
 * armed": the pane spawns without KeepDeck's servers, which is the same
 * outcome as the transport being off — never a dead spawn. */
export async function mcpArm(
  wsId: string,
  entries: McpArmEntry[],
): Promise<McpArmReport> {
  try {
    return await invoke<McpArmReport>("mcp_arm", { wsId, entries });
  } catch (e) {
    log.warn("web:mcp", `arming failed: ${describeError(e)}`);
    return NOTHING;
  }
}

/** Take KeepDeck's config back out of these cwds. Reports whether it got
 * through: a sweep must not record itself as done on a failed pass. */
export async function mcpDisarm(roots: string[]): Promise<boolean> {
  if (roots.length === 0) return true;
  try {
    await invoke("mcp_disarm", { roots });
    return true;
  } catch (e) {
    log.warn("web:mcp", `disarm failed: ${describeError(e)}`);
    return false;
  }
}

/** Sweep what workspaces that are gone left in their cwds. */
export async function mcpPrune(liveWsIds: string[]): Promise<boolean> {
  try {
    await invoke("mcp_prune", { liveWsIds });
    return true;
  } catch (e) {
    log.warn("web:mcp", `prune failed: ${describeError(e)}`);
    return false;
  }
}
