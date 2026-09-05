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
 */
import type { McpServerSpec } from "@keepdeck/plugin-api";
import { acceptMcpServers } from "./servers";
import { describeError, log } from "../../ipc/log";
import type { McpArmReport } from "../../ipc/mcpArming";
import type { BundledMcpContributor } from "./bundled";
import { mcpFileRenderer } from "./kimi";

/** The pane an injection is for: which CLI, and where it will run. */
export interface McpInjectionTarget {
  agentType: string;
  cwd: string;
  workspaceId: string;
  /** The pane secret this spawn's clients announce, so the deck can name the
   * pane behind a connection. */
  client: string;
}

/** One library server, ready to inject: the spec a hook renders, and what the
 * pane's environment must carry for it — the values the spec only names. */
export interface McpLibraryServer {
  spec: McpServerSpec;
  env: [string, string][];
}

/** The user's library, as this consumer needs it: one workspace's effective
 * set, already resolved (a workspace entry over a global one by name is the
 * library's rule, not this module's). */
export interface McpServerSource {
  serversFor(workspaceId: string): Promise<McpLibraryServer[]>;
}

/** A library with nothing in it — the tier as it stands before an owner is
 * wired, and the honest stand-in for a test that has no library to speak of. */
export const NO_MCP_SERVERS: McpServerSource = {
  serversFor: () => Promise.resolve([]),
};

/**
 * One pane's access to its MCP servers, in the two forms a CLI can take
 * delivery of them — and deliberately BOTH: a single answer that hid the
 * on-disk half behind a list of argv defs is what let a query write to a
 * spawning pane's working directory with no caller able to see it.
 */
export interface McpAccess {
  /** The servers this pane is given THROUGH ITS ARGV — the hook's material.
   * Empty when neither tier has anything for this pane, and for a CLI that
   * reads a file instead. */
  servers: McpServerSpec[];
  /** What the pane's environment must carry for the injected servers to work
   * — always, whatever the delivery: a file-fed CLI's children inherit the
   * pane's environment exactly as an argv-fed one's do. */
  env: [string, string][];
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
 * per session: the bundled tier's answers move (the socket is confirmed some
 * time after boot) and so does the library. */
export type McpAccessAsk = (target: McpInjectionTarget) => Promise<McpAccess>;

export interface McpInjection {
  access: McpAccessAsk;
}

export interface McpInjectionDeps {
  /** The bundled tier, in the order its members are filed. */
  contributors: readonly BundledMcpContributor[];
  /** The user's library. REQUIRED even when empty (`NO_MCP_SERVERS`): a
   * default here would make "no library" the easy, silent form. */
  library: McpServerSource;
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

/** A pane that gets nothing: no servers on argv, nothing in its environment,
 * and nothing to put on disk. */
const NO_ACCESS: McpAccess = {
  servers: [],
  env: [],
  deliver: () => Promise.resolve(),
};

export function createMcpInjection({
  contributors,
  library,
  panesIn,
  plant,
  onRefused = () => {},
  onArmed = () => {},
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
            `bundled server "${contributor.name}" not injected: ${describeError(e)}`,
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
  async function libraryFor(workspaceId: string): Promise<McpLibraryServer[]> {
    try {
      return await library.serversFor(workspaceId);
    } catch (e) {
      log.warn("web:mcp", `MCP library unreadable — pane spawns without it: ${describeError(e)}`);
      return [];
    }
  }

  /** kimi's half of a delivery: the config into the pane's cwd, and what came
   * back reported. A cwd holding the user's own config refuses, and the
   * refusal is surfaced rather than silently leaving that pane serverless. */
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
      const client = shared ? null : target.client;
      const [bundled, fromLibrary] = await Promise.all([
        bundledFor(target, client),
        libraryFor(target.workspaceId),
      ]);
      const { accepted, rejected } = acceptMcpServers([
        ...bundled,
        ...fromLibrary.map((server) => server.spec),
      ]);
      for (const { name, reason } of rejected) {
        log.warn("web:mcp", `server "${name}" not injected: ${reason}`);
      }
      if (accepted.length === 0) return NO_ACCESS;
      // Only what was ACCEPTED gets its environment: a library entry dropped
      // for its name must not leave its values in the pane either.
      const env = fromLibrary
        .filter((server) => accepted.includes(server.spec))
        .flatMap((server) => server.env);
      if (!render) return { servers: accepted, env, deliver: () => Promise.resolve() };
      // A file-fed CLI takes nothing on argv, so its servers ride the delivery
      // instead and the hook is told there is nothing to add. The content is
      // rendered NOW, against the set this pane was answered with, and
      // written later.
      const content = render(accepted);
      return { servers: [], env, deliver: () => deliverFile(target, content) };
    },
  };
}
