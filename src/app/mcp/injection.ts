/**
 * What a spawning pane must be told in order to reach KeepDeck's MCP server.
 *
 * The one home for "which MCP servers does an agent get, and how are they
 * addressed". Two rules live here and nowhere else:
 *
 * - the gate is the CONFIRMED transport status, never the setting. A pane
 *   handed a def for a socket that is down would spend its startup connecting
 *   to nothing and show a failed server instead of no server;
 * - the gate is read at plan mint: an argv definition is frozen for that
 *   spawn and cannot be repaired after the hook returns;
 * - the invocation is whatever the backend says it is
 *   ([`mcpConnectionCommand`]), never rebuilt here. The shim flag and the
 *   socket path have exactly one home, on the Rust side, and a second
 *   derivation would drift the day either changes.
 *
 * It answers with a LIST because the planned server bank contributes more
 * members later; today the built-in transport is the only one.
 */
import type { McpServerSpec } from "@keepdeck/plugin-api";
import { acceptMcpServers } from "./servers";
import { describeError, log } from "../../ipc/log";
import { mcpConnectionCommand, type McpConnection } from "../../ipc/mcp";
import type { McpArmReport } from "../../ipc/mcpArming";
import { mcpFileRenderer } from "./kimi";

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

/**
 * One pane's access to KeepDeck's MCP servers, in the two forms a CLI can
 * take delivery of them — and deliberately BOTH: a single answer that hid the
 * on-disk half behind a list of argv defs is what let a query write to a
 * spawning pane's working directory with no caller able to see it.
 */
export interface McpAccess {
  /** The servers this pane is given THROUGH ITS ARGV — the hook's material.
   * Empty when the transport is not confirmed up, when the backend cannot say
   * how to reach it (in both cases the pane spawns with no KeepDeck server
   * rather than a broken one), and for a CLI that reads a file instead. */
  servers: McpServerSpec[];
  /**
   * Put the file-delivered half on disk. A no-op for the argv CLIs.
   *
   * Split out of the answer, and called only once the plan is settled, so a
   * plan that is REJECTED (a resume whose hook threw) plants nothing: a
   * config naming a pane that will never spawn is a file the user never asked
   * for in a directory they own. Never rejects — a delivery that failed
   * leaves the pane serverless, never unspawned.
   */
  deliver(): Promise<void>;
}

/** Ask for one pane's access, at the moment its plan is built — never once
 * per session: the socket is confirmed some time after boot, and the answer
 * moves with it. */
export type McpAccessAsk = (target: McpInjectionTarget) => Promise<McpAccess>;

export interface McpInjection {
  access: McpAccessAsk;
}

export interface McpInjectionDeps {
  /** The CONFIRMED socket, or null. Read per call: it is null until the
   * transport's enable settles — a pane restored at boot can ask before that
   * — and a remembered answer would outlive the fact. Once claimed it stays
   * claimed for the page's life, so a plan minted against it never outlives
   * its socket. */
  socket: () => string | null;
  connection?: (client?: string) => Promise<McpConnection>;
  /** Plant a config in a pane's cwd. REQUIRED, not defaulted: the write must
   * be ORDERED against worktree teardown, and REFUSED for a directory no live
   * pane claims any more — both of which are the worktree owner's knowledge,
   * not this module's. A default would be the unguarded call, i.e. the unsafe
   * form would be the easy one. */
  plant: (
    workspaceId: string,
    root: string,
    content: string,
  ) => Promise<McpArmReport>;
  /** How many live panes run in this directory. A config is ONE file, so a
   * directory shared by two panes cannot carry a per-pane secret — see
   * [`McpInjection.access`]. Asked per call: panes come and go between
   * spawns. */
  panesIn: (cwd: string) => number;
  /** Where a directory kept its own config instead. Reported rather than
   * only logged: those panes are the only ones silently lacking what every
   * other pane got, and the fix is the user's to make. */
  onRefused?: (refusals: { root: string; reason: string }[]) => void;
  /** Where the config DID land — so a refusal that no longer holds (the user
   * moved their file away) stops being reported. */
  onArmed?: (roots: string[]) => void;
}

/** A pane that gets nothing: no servers on argv, and nothing to put on disk. */
const NO_ACCESS: McpAccess = { servers: [], deliver: () => Promise.resolve() };

/** A pane served entirely through its argv — every CLI but kimi. */
function argvOnly(servers: McpServerSpec[]): McpAccess {
  return { servers, deliver: () => Promise.resolve() };
}

export function createMcpInjection({
  socket,
  panesIn,
  plant,
  connection = mcpConnectionCommand,
  onRefused = () => {},
  onArmed = () => {},
}: McpInjectionDeps): McpInjection {
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

  /** kimi's half of a delivery: the config into the pane's cwd, and what came
   * back reported. A cwd holding the user's own config refuses, and the
   * refusal is surfaced rather than silently leaving that pane serverless.
   * Not re-gated on the socket: the plan it belongs to was minted against a
   * confirmed one, and a claimed socket is never given up while the page
   * lives. */
  async function deliverFile(
    target: McpInjectionTarget,
    content: string,
  ): Promise<void> {
    const report = await plant(target.workspaceId, target.cwd, content);
    for (const { root, reason } of report.refused) {
      log.warn("web:mcp", `${root} could not take KeepDeck's MCP config: ${reason}`);
    }
    onArmed(report.armed);
    onRefused(report.refused);
  }

  return {
    async access(target) {
      if (socket() === null) return NO_ACCESS;
      const render = mcpFileRenderer(target.agentType);
      // A shared directory gets no secret ON THE INVOCATION. File delivery is
      // one file per directory, so two panes running there would both announce
      // whichever secret was written last — and naming the wrong pane is worse
      // than naming none. A property of the DELIVERY, not of any one CLI.
      //
      // It is no longer anonymous, though: the shim falls back to the secret
      // in `KEEPDECK_BRIDGE`, which every process under a pane inherits and
      // which names that pane exactly. Before that, a file-fed pane sharing a
      // directory could not use a pane-scoped tool at all — mail refused it
      // with "this connection is not attached to a pane".
      const shared = render !== null && panesIn(target.cwd) > 1;
      const invoked = await resolve(shared ? null : target.client);
      if (!invoked) return NO_ACCESS;
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
      if (!render) return argvOnly(accepted);
      // A file-fed CLI takes nothing on argv, so its servers ride the delivery
      // instead and the hook is told there is nothing to add. The content is
      // rendered NOW, against the invocation this pane was answered with, and
      // written later.
      const content = render(accepted);
      return { servers: [], deliver: () => deliverFile(target, content) };
    },
  };
}
