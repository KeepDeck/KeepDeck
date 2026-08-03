import { invoke } from "@tauri-apps/api/core";
import { describeError, log } from "./log";

/** One pane cwd and the MCP config it should carry. */
export interface McpArmEntry {
  root: string;
  content: string;
}

/** What one arming pass did, and where it refused — with the reason, which is
 * the message the app puts in front of the user: a directory that keeps its
 * own config, one that is gone, one it cannot write. Those panes are the only
 * ones silently lacking what every other pane got, so none of it may be
 * reduced to a shrug. */
export interface McpArmReport {
  armed: string[];
  refused: { root: string; reason: string }[];
}

/** Plant the config in each cwd. The pane spawns either way — a failure here
 * costs it KeepDeck's servers, never its process.
 *
 * A failure is reported as a REFUSAL of every cwd it was asked about, not as
 * an empty report: an empty report is exactly what a fully successful pass
 * with nothing to do looks like, so degrading to one made a dead backend
 * indistinguishable from a working one and left the pane's missing servers
 * with nowhere to surface. */
export async function mcpArm(
  wsId: string,
  entries: McpArmEntry[],
): Promise<McpArmReport> {
  try {
    return await invoke<McpArmReport>("mcp_arm", { wsId, entries });
  } catch (e) {
    const reason = describeError(e);
    log.warn("web:mcp", `arming failed: ${reason}`);
    return {
      armed: [],
      refused: entries.map(({ root }) => ({ root, reason })),
    };
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
