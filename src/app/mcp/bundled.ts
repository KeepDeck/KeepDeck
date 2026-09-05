/**
 * The bundled tier of MCP servers: what KeepDeck ships, as opposed to what
 * the user keeps in their library.
 *
 * Each member is a CONTRIBUTOR — asked per pane, answering a spec or nothing
 * — because a shipped server has a condition of its own on whether it is
 * worth handing out. The deck's own transport is reachable only while its
 * socket is confirmed up, and a pane handed a def for a socket that is down
 * would spend its startup connecting to nothing and show a failed server
 * instead of no server. That condition is the server's business, not the
 * injection's, which is why the gate lives here and the injection only
 * collects answers.
 *
 * One member today. The registry is the array the composition root hands
 * the injection; a second shipped server (the mnemo connector is the planned
 * one) is a second factory here and one more element there. Names in this
 * tier are RESERVED — the library refuses to author one — because a shipped
 * server can carry what a user's cannot (the pane secret below), and a
 * same-name library entry would replace it silently in some CLIs and not in
 * others.
 */
import type { McpServerSpec } from "@keepdeck/plugin-api";
import { describeError, log } from "../../ipc/log";
import { mcpConnectionCommand, type McpConnection } from "../../ipc/mcp";

/** The pane a contribution is for. `client` is the secret this pane's
 * clients announce so the deck can name the pane behind a connection — or
 * null when the delivery cannot carry one (a file shared by two panes; see
 * the injection). */
export interface McpContributionTarget {
  agentType: string;
  cwd: string;
  workspaceId: string;
  client: string | null;
}

/** One server KeepDeck ships. Decides for itself whether it has anything for
 * a pane: `null` is "nothing today", not an error. */
export interface BundledMcpContributor {
  /** The key the server is filed under in every client config, and so the
   * prefix its tools carry (`mcp__<name>__…`). */
  name: string;
  contribute(target: McpContributionTarget): Promise<McpServerSpec | null>;
}

/** The name KeepDeck's own server is filed under — and therefore the prefix
 * its tools carry (`mcp__keepdeck__…`). */
export const KEEPDECK_MCP_SERVER = "keepdeck";

export interface KeepdeckServerDeps {
  /** The CONFIRMED socket, or null. Read per call: it is null until the
   * transport's enable settles — a pane restored at boot can ask before that
   * — and a remembered answer would outlive the fact. Once claimed it stays
   * claimed for the page's life, so a plan minted against it never outlives
   * its socket. */
  socket: () => string | null;
  connection?: (client?: string) => Promise<McpConnection>;
}

/**
 * KeepDeck's own transport as a bundled server.
 *
 * The invocation is whatever the backend says it is ([`mcpConnectionCommand`]),
 * never rebuilt here: the shim flag and the socket path have exactly one
 * home, on the Rust side, and a second derivation would drift the day either
 * changes. It is per PANE (it names the pane's secret), so unlike the
 * install-wide parts of it there is nothing to cache. A failure answers
 * nothing and is not remembered: the backend may serve the next pane, and
 * refusing forever because one call failed would need a restart.
 */
export function keepdeckServer({
  socket,
  connection = mcpConnectionCommand,
}: KeepdeckServerDeps): BundledMcpContributor {
  return {
    name: KEEPDECK_MCP_SERVER,
    async contribute(target) {
      if (socket() === null) return null;
      try {
        const invoked = await connection(target.client ?? undefined);
        return {
          name: KEEPDECK_MCP_SERVER,
          transport: "stdio",
          command: invoked.command,
          args: invoked.args,
        };
      } catch (e) {
        log.warn(
          "web:mcp",
          `no connect invocation for injection: ${describeError(e)}`,
        );
        return null;
      }
    },
  };
}
