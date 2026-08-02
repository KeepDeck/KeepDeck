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
import type { AgentMcpFileDelivery, McpServerSpec } from "@keepdeck/plugin-api";
import { acceptMcpServers } from "./servers";
import { describeError, log } from "../../ipc/log";
import { mcpConnectionCommand, type McpConnection } from "../../ipc/mcp";
import type { McpArmEntry, McpArmReport } from "../../ipc/mcpArming";

/** The name KeepDeck's own server is filed under in every client config —
 * and therefore the prefix its tools carry (`mcp__keepdeck__…`). */
export const KEEPDECK_MCP_SERVER = "keepdeck";

/** The pane an injection is for: which CLI, where it will run, and how that
 * CLI takes its servers. */
export interface McpInjectionTarget {
  agentType: string;
  cwd: string;
  workspaceId: string;
  /** The pane secret this spawn's clients announce, so the deck can name the
   * pane behind a connection. */
  client: string;
  /** Declared by the agent's plugin when its CLI has no argv door: where the
   * file goes and what goes in it. Absent = argv, and the hook renders it.
   *
   * Passed IN rather than looked up here, so this module never names an
   * agent: it used to branch on the literal id `kimi` and the backend
   * hardcoded `.kimi-code`, which put one CLI's dialect in two host files and
   * left its own plugin describing an agent it no longer fully described. */
  file?: AgentMcpFileDelivery;
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
 * per session: the transport toggles, and the answer moves with it. */
export type McpAccessAsk = (target: McpInjectionTarget) => Promise<McpAccess>;

export interface McpInjection {
  access: McpAccessAsk;
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
  /** Plant a config in a pane's cwd. REQUIRED, not defaulted: the write must
   * be ORDERED against worktree teardown, and REFUSED for a directory no live
   * pane claims any more — both of which are the worktree owner's knowledge,
   * not this module's. A default would be the unguarded call, i.e. the unsafe
   * form would be the easy one. */
  plant: (entry: McpArmEntry) => Promise<McpArmReport>;
  /** Take a planted config back out of these directories. Paired with
   * `plant`, and ordered the same way. */
  retract: (roots: string[]) => Promise<boolean>;
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
  retract,
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

  /** The file half of a delivery: the config into the pane's cwd, and what
   * came back reported. A cwd holding the user's own config refuses, and the
   * refusal is surfaced rather than silently leaving that pane serverless. */
  async function deliverFile(
    target: McpInjectionTarget & { file: AgentMcpFileDelivery },
    content: string,
  ): Promise<void> {
    // Re-checked here and not only at `access`: the plan is built between the
    // two, and a toggle that went Off in that window has already run its
    // retract — a config planted after it would be one nothing takes back.
    if (socket() === null) return;
    const report = await plant({
      workspaceId: target.workspaceId,
      root: target.cwd,
      dir: target.file.dir,
      name: target.file.name,
      content,
    });
    for (const { root, reason } of report.refused) {
      log.warn("web:mcp", `${root} could not take KeepDeck's MCP config: ${reason}`);
    }
    // And re-checked AFTER the write, which waited in the worktree owner's
    // queue and can easily be a whole teardown late. `retract()` reads
    // `planted` and clears it; a root added here after that read is one it
    // never saw, so the config would sit in the user's directory naming a
    // socket that is gone. Take it straight back instead.
    if (socket() === null) {
      if (report.armed.length > 0) void retract(report.armed);
      return;
    }
    for (const root of report.armed) planted.add(root);
    onArmed(report.armed);
    onRefused(report.refused);
  }

  return {
    async access(target) {
      if (socket() === null) return NO_ACCESS;
      // A shared directory gets an ANONYMOUS invocation. A file delivery is
      // one file per directory, so two panes running there would both announce
      // whichever secret was written last — and the journal would name the
      // wrong pane, which is worse than naming none. Only file-fed CLIs are
      // affected: everyone else carries their own argv.
      const shared = target.file !== undefined && panesIn(target.cwd) > 1;
      const invoked = await resolve(shared ? null : target.client);
      if (!invoked) return NO_ACCESS;
      // Re-checked after the await: the toggle may have gone Off while the
      // backend was answering, and a def minted then would be handed to a
      // pane whose socket no longer exists.
      if (socket() === null) return NO_ACCESS;
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
      const { file } = target;
      if (!file) return argvOnly(accepted);
      // A file-fed CLI takes nothing on argv, so its servers ride the delivery
      // instead and the hook is told there is nothing to add. The body is
      // rendered NOW by the plugin that owns the dialect, against the
      // invocation this pane was answered with, and written later.
      const content = file.render({ servers: accepted });
      return {
        servers: [],
        deliver: () => deliverFile({ ...target, file }, content),
      };
    },

    async retract() {
      if (planted.size === 0) return;
      const roots = [...planted];
      // Cleared up front: a failed retract must not keep re-trying the same
      // directories on every later Off, and what survives on disk is still
      // recorded in the backend's own armed manifest, which the boot sweep
      // reads.
      planted.clear();
      await retract(roots);
      onArmed(roots);
      onRefused([]);
    },
  };
}
