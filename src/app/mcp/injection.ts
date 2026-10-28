/**
 * What a spawning pane must be told in order to reach its MCP servers.
 *
 * The one home for "which MCP servers does an agent get, and how are they
 * addressed". The set is assembled from two tiers, in this order:
 *
 * - the BUNDLED tier — servers KeepDeck ships, each a contributor that
 *   decides for itself whether it has anything for this pane (see
 *   [`BundledMcpContributor`]);
 * - the user's LIBRARY for this pane's workspace, which knows nothing of the
 *   deck's transport and is never gated on it — a socket that has not come up
 *   must not cost the user the servers they configured themselves.
 *
 * Bundled entries come first and `acceptMcpServers` lets the first claim on a
 * name win, so a library entry can never shadow a shipped one — the library
 * refuses to author such a name, and this is the backstop.
 *
 * Two rules live here and nowhere else:
 * - the set is read at plan mint: an argv definition is frozen for that spawn
 *   and cannot be repaired after the hook returns;
 * - a value a server needs rides the PANE's environment, never argv (several
 *   CLIs take their config where `ps` reads it): the library hands back what
 *   to set and the spec only NAMES it, and the plan carries the pairs.
 *
 * A known boundary: a pane whose agent runs against a REMOTE endpoint gets
 * these servers rendered like any other, and its CLI ignores them — the
 * config lands on the local thin client while the agent that would spawn
 * the server runs on the box. Serving remote panes means provisioning
 * server-side, which is the remote setup's business, not this module's.
 */
import { errorMessage, type McpServerSpec } from "@keepdeck/plugin-api";
import { acceptMcpServers } from "./servers";
import { log } from "../../ipc/log";
import type { BundledMcpContributor } from "./bundled";

/** The pane an injection is for: which CLI, and where it will run. */
export interface McpInjectionTarget {
  agentType: string;
  cwd: string;
  workspaceId: string;
  /** The pane secret this spawn's clients announce, so the deck can name the
   * pane behind a connection. */
  client: string;
}

/** One server ready to inject: the spec a hook renders, and what the pane's
 * environment must carry for it — the values the spec only names. The two
 * travel as ONE thing so that whoever drops the spec drops its values too. */
export interface McpInjectable {
  spec: McpServerSpec;
  env: [string, string][];
}

/** The user's library, as this consumer needs it: one workspace's effective
 * set, already resolved (a workspace entry over a global one by name is the
 * library's rule, not this module's). */
export interface McpServerSource {
  serversFor(workspaceId: string): Promise<McpInjectable[]>;
}

/**
 * One pane's access to its MCP servers. How they reach its CLI — argv, env,
 * or a file in its cwd — is the agent's plugin's to render; a file goes
 * through `arm.plan` and the host's cwd arming engine like anything else a
 * plugin plants.
 */
export interface McpAccess {
  /** The servers this pane gets, each with what its environment must carry.
   * Every entry's `env` is owed to the pane whatever the delivery: a
   * file-fed CLI's children inherit the pane's environment exactly as an
   * argv-fed one's do. */
  entries: McpInjectable[];
}

/** Ask for one pane's access, at the moment its plan is built — never once
 * per session: the bundled tier's answers move (the socket is confirmed some
 * time after boot) and so does the library. */
export type McpAccessAsk = (target: McpInjectionTarget) => Promise<McpAccess>;

export interface McpInjection {
  access: McpAccessAsk;
}

export interface McpInjectionDeps {
  /** The bundled tier, in the order its members are filed. */
  contributors: readonly BundledMcpContributor[];
  /** The user's library. REQUIRED even when empty: a default here would make
   * "no library" the easy, silent form. */
  library: McpServerSource;
  /** How many live panes run in this directory. A config file in the cwd is
   * ONE file, so a directory shared by two panes cannot carry a per-pane
   * secret — see [`McpInjection.access`]. Asked per call: panes come and go
   * between spawns. */
  panesIn: (cwd: string) => number;
  /** Whether this agent takes its servers through a file in its cwd — its
   * plugin's declaration (`integration.mcp` → `delivery: "cwd"`), never a
   * name this module knows. */
  deliversByCwd: (agentType: string) => boolean;
}

export function createMcpInjection({
  contributors,
  library,
  panesIn,
  deliversByCwd,
}: McpInjectionDeps): McpInjection {
  /** The bundled tier's answers for one pane, in registry order. A member
   * that throws costs the pane that server, never the others — and never the
   * spawn: the contributor's own failure is logged, and the tier goes on. */
  async function bundledFor(
    target: McpInjectionTarget,
    client: string | null,
  ): Promise<McpServerSpec[]> {
    const answers = await Promise.all(
      contributors.map(async (contributor) => {
        try {
          return await contributor.contribute({ ...target, client });
        } catch (e) {
          log.warn(
            "web:mcp",
            `bundled server "${contributor.name}" not injected: ${errorMessage(e)}`,
          );
          return null;
        }
      }),
    );
    return answers.filter((spec): spec is McpServerSpec => spec !== null);
  }

  /** The library's servers for one workspace. A library that cannot be read
   * costs the pane its library servers, never its bundled ones and never its
   * process — and says so once, here. */
  async function libraryFor(workspaceId: string): Promise<McpInjectable[]> {
    try {
      return await library.serversFor(workspaceId);
    } catch (e) {
      log.warn("web:mcp", `MCP library unreadable — pane spawns without it: ${errorMessage(e)}`);
      return [];
    }
  }

  return {
    async access(target) {
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
      const shared = deliversByCwd(target.agentType) && panesIn(target.cwd) > 1;
      const client = shared ? null : target.client;
      const [bundled, fromLibrary] = await Promise.all([
        bundledFor(target, client),
        libraryFor(target.workspaceId),
      ]);
      // A bundled server carries no values of its own: what it needs, the
      // shim reads from the pane's bridge variable.
      const candidates: McpInjectable[] = [
        ...bundled.map((spec) => ({ spec, env: [] as [string, string][] })),
        ...fromLibrary,
      ];
      const { accepted, rejected } = acceptMcpServers(candidates.map((entry) => entry.spec));
      for (const { name, reason } of rejected) {
        log.warn("web:mcp", `server "${name}" not injected: ${reason}`);
      }
      // Only what was ACCEPTED goes on: an entry dropped for its name takes
      // its values with it — spec and env are one thing here.
      return { entries: candidates.filter((entry) => accepted.includes(entry.spec)) };
    },
  };
}
