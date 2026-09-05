/** The MCP feature's adapter for the infrastructure planting port. */
import { mcpArm } from "../../ipc/mcpArming";
import type { McpPlanting } from "../worktrees";
import type { InOrder } from "../worktrees/queue";

export function createMcpPlanting(inOrder: InOrder): McpPlanting {
  return {
    plantMcp(workspaceId, root, content) {
      return inOrder(() => mcpArm(workspaceId, [{ root, content }]));
    },
  };
}
