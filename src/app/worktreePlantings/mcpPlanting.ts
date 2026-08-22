/** The MCP feature's adapter for the infrastructure planting port. */
import { mcpArm, mcpDisarm } from "../../ipc/mcpArming";
import type { McpPlanting } from "../worktrees";
import type { InOrder } from "../worktrees/queue";

export function createMcpPlanting(inOrder: InOrder): McpPlanting {
  return {
    plantMcp(workspaceId, root, content) {
      return inOrder(() => mcpArm(workspaceId, [{ root, content }]));
    },

    retractMcp(roots) {
      return inOrder(() => mcpDisarm(roots));
    },
  };
}
