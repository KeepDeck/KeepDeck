/**
 * What a spawning pane must be told in order to reach KeepDeck's MCP server.
 *
 * The one home for "which MCP servers does an agent get, and how are they
 * addressed". Two rules live here and nowhere else:
 *
 * - the gate is the CONFIRMED transport status, never the setting. A pane
 *   handed a def for a socket that is down would spend its startup connecting
 *   to nothing and show a failed server instead of no server;
 * - the invocation is whatever the backend says it is
 *   ([`mcpConnectionCommand`]), never rebuilt here. The shim flag and the
 *   socket path have exactly one home, on the Rust side, and a second
 *   derivation would drift the day either changes.
 *
 * It answers with a LIST because the planned server bank contributes more
 * members later; today the built-in transport is the only one.
 */
import { acceptMcpServers, type McpServerDef } from "../../domain/mcp";
import { describeError, log } from "../../ipc/log";
import { mcpConnectionCommand, type McpConnection } from "../../ipc/mcp";
import { mcpArm, type McpArmReport } from "../../ipc/mcpArming";
import { kimiMcpConfig, KIMI_AGENT } from "./kimi";

/** The name KeepDeck's own server is filed under in every client config —
 * and therefore the prefix its tools carry (`mcp__keepdeck__…`). */
export const KEEPDECK_MCP_SERVER = "keepdeck";

/** The pane an injection is for: which CLI, and where it will run. */
export interface McpInjectionTarget {
  agentType: string;
  cwd: string;
  workspaceId: string;
}

export interface McpInjection {
  /** The servers this pane should be given THROUGH ITS ARGV. Empty when the
   * transport is not confirmed up, when the backend cannot say how to reach
   * it — in both cases the pane spawns with no KeepDeck server rather than a
   * broken one — and for kimi, whose servers are delivered as a file instead
   * (planted here, so the answer stays "nothing for the hook to add"). */
  defs(target: McpInjectionTarget): Promise<McpServerDef[]>;
}

export interface McpInjectionDeps {
  /** The CONFIRMED socket, or null. Read per call: the toggle can flip
   * between two spawns, and a remembered answer would outlive the fact. */
  socket: () => string | null;
  connection?: () => Promise<McpConnection>;
  /** Plant kimi's config in a pane cwd. Injected because the write must be
   * ORDERED against worktree teardown — arming a directory that is being
   * deleted is the mistake the worktree owner's queue exists to prevent — and
   * that queue is not this module's to hold. */
  arm?: (
    workspaceId: string,
    entries: { root: string; content: string }[],
  ) => Promise<McpArmReport>;
}

export function createMcpInjection({
  socket,
  connection = mcpConnectionCommand,
  arm = mcpArm,
}: McpInjectionDeps): McpInjection {
  /** The connect invocation is a property of the INSTALL (this binary, this
   * home), so it is fetched once and reused. A failure is not remembered:
   * the backend may answer the next pane, and refusing forever because one
   * call failed would need a restart to recover. */
  let invocation: Promise<McpConnection> | null = null;

  async function resolve(): Promise<McpConnection | null> {
    const pending = (invocation ??= connection());
    try {
      return await pending;
    } catch (e) {
      if (invocation === pending) invocation = null;
      log.warn(
        "web:mcp",
        `no connect invocation for injection: ${describeError(e)}`,
      );
      return null;
    }
  }

  return {
    async defs(target) {
      if (socket() === null) return [];
      const invoked = await resolve();
      if (!invoked) return [];
      // Re-checked after the await: the toggle may have gone Off while the
      // backend was answering, and a def minted then would be handed to a
      // pane whose socket no longer exists.
      if (socket() === null) return [];
      const { accepted, rejected } = acceptMcpServers([
        {
          name: KEEPDECK_MCP_SERVER,
          transport: "stdio",
          command: invoked.command,
          args: invoked.args,
        },
      ]);
      for (const { name, reason } of rejected) {
        log.warn("web:mcp", `server "${name}" not injected: ${reason}`);
      }
      if (target.agentType !== KIMI_AGENT) return accepted;
      // kimi reads a FILE and takes nothing on argv, so the delivery happens
      // here and the hook is told there is nothing to add. A cwd holding the
      // user's own config refuses, and the refusal is reported rather than
      // silently leaving that pane serverless.
      const report = await arm(target.workspaceId, [
        { root: target.cwd, content: kimiMcpConfig(accepted) },
      ]);
      for (const { root, reason } of report.refused) {
        log.warn("web:mcp", `${root} kept its own MCP config: ${reason}`);
      }
      return [];
    },
  };
}
