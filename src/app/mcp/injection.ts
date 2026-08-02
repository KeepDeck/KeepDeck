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
import type { McpArmReport } from "../../ipc/mcpArming";
import { kimiMcpConfig, KIMI_AGENT } from "./kimi";

/** The name KeepDeck's own server is filed under in every client config —
 * and therefore the prefix its tools carry (`mcp__keepdeck__…`). */
export const KEEPDECK_MCP_SERVER = "keepdeck";

/** The pane an injection is for: which CLI, and where it will run. */
export interface McpInjectionTarget {
  agentType: string;
  cwd: string;
  workspaceId: string;
  /** The pane secret this spawn's clients announce, so the deck can name the
   * pane behind a connection. */
  client: string;
}

export interface McpInjection {
  /** The servers this pane should be given THROUGH ITS ARGV. Empty when the
   * transport is not confirmed up, when the backend cannot say how to reach
   * it — in both cases the pane spawns with no KeepDeck server rather than a
   * broken one — and for kimi, whose servers are delivered as a file instead
   * (planted here, so the answer stays "nothing for the hook to add"). */
  defs(target: McpInjectionTarget): Promise<McpServerDef[]>;
  /** Take back everything planted so far. Off means the socket is gone, so a
   * config still naming it would point kimi at nothing — and the settings
   * page promises the toggle tears its clients down. */
  retract(): Promise<void>;
}

export interface McpInjectionDeps {
  /** The CONFIRMED socket, or null. Read per call: the toggle can flip
   * between two spawns, and a remembered answer would outlive the fact. */
  socket: () => string | null;
  connection?: (client?: string) => Promise<McpConnection>;
  /** Plant kimi's config in a pane cwd. REQUIRED, not defaulted: the write
   * must be ORDERED against worktree teardown — arming a directory that is
   * being deleted is the mistake the worktree owner's queue exists to
   * prevent — and that queue is not this module's to hold. A default would be
   * the unordered call, i.e. the unsafe form would be the easy one. */
  arm: (
    workspaceId: string,
    entries: { root: string; content: string }[],
  ) => Promise<McpArmReport>;
  /** Take a planted config back out of these directories. Paired with `arm`,
   * and ordered the same way. */
  disarm: (roots: string[]) => Promise<boolean>;
  /** How many live panes run in this directory. A config is ONE file, so a
   * directory shared by two panes cannot carry a per-pane secret — see
   * [`defs`]. Asked per call: panes come and go between spawns. */
  panesIn: (cwd: string) => number;
  /** Where a directory kept its own config instead. Reported rather than
   * only logged: those panes are the only ones silently lacking what every
   * other pane got, and the fix is the user's to make. */
  onRefused?: (refusals: { root: string; reason: string }[]) => void;
  /** Where the config DID land — so a refusal that no longer holds (the user
   * moved their file away) stops being reported. */
  onArmed?: (roots: string[]) => void;
}

export function createMcpInjection({
  socket,
  panesIn,
  arm,
  disarm,
  connection = mcpConnectionCommand,
  onRefused = () => {},
  onArmed = () => {},
}: McpInjectionDeps): McpInjection {
  /** Every directory this session planted in, so Off can take them all back.
   * Kept here rather than re-derived from the deck: the deck knows where panes
   * RUN, this knows where a file actually landed — a cwd that refused is in
   * one and not the other. */
  const planted = new Set<string>();

  /** The invocation is per PANE (it names the pane's secret), so unlike the
   * install-wide parts of it there is nothing to cache. A failure answers
   * null and is not remembered: the backend may serve the next pane, and
   * refusing forever because one call failed would need a restart. */
  async function resolve(
    client: string | null,
  ): Promise<McpConnection | null> {
    try {
      return await connection(client ?? undefined);
    } catch (e) {
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
      // A shared directory gets an ANONYMOUS invocation. kimi's config is one
      // file per directory, so two panes running there would both announce
      // whichever secret was written last — and the journal would name the
      // wrong pane, which is worse than naming none.
      const shared =
        target.agentType === KIMI_AGENT && panesIn(target.cwd) > 1;
      const invoked = await resolve(shared ? null : target.client);
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
      for (const root of report.armed) planted.add(root);
      onArmed(report.armed);
      onRefused(report.refused);
      return [];
    },

    async retract() {
      if (planted.size === 0) return;
      const roots = [...planted];
      // Cleared up front: a failed disarm must not keep re-trying the same
      // directories on every later Off, and what survives on disk is still
      // recorded in the backend's own armed manifest, which the boot sweep
      // reads.
      planted.clear();
      await disarm(roots);
      onArmed(roots);
      onRefused([]);
    },
  };
}
