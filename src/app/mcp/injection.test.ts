import { describe, expect, it, vi } from "vitest";
import type { BundledMcpContributor, McpContributionTarget } from "./bundled";
import {
  createMcpInjection,
  type McpAccess,
  type McpInjectable,
  type McpInjectionTarget,
  type McpServerSource,
} from "./injection";

/** A shipped server that answers for every pane, and shows what it was asked
 * with — the invocation names the client when there is one. */
function shipped(name = "keepdeck"): BundledMcpContributor & {
  asked: McpContributionTarget[];
} {
  const asked: McpContributionTarget[] = [];
  return {
    name,
    asked,
    describe: () => null,
    contribute: async (target) => {
      asked.push(target);
      return {
        name,
        transport: "stdio",
        command: "/bin/keepdeck",
        args: target.client
          ? ["--mcp-shim", "/s", "--client", target.client]
          : ["--mcp-shim", "/s"],
      };
    },
  };
}

/** A shipped server with nothing for anyone today. */
const silent: BundledMcpContributor = {
  name: "mnemo",
  describe: () => null,
  contribute: async () => null,
};

const library = (...servers: McpInjectable[]): McpServerSource => ({
  serversFor: async () => servers,
});

const github: McpInjectable = {
  spec: {
    name: "github",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    bearerTokenEnv: "GH_TOKEN",
  },
  env: [["GH_TOKEN", "ghp_secret"]],
};

const local = (name: string, env: [string, string][] = []): McpInjectable => ({
  spec: { name, transport: "stdio", command: "/usr/bin/npx", args: ["-y", name] },
  env,
});

/** The ports every construction needs. `plant` and `library` are required by
 * design — the guarded form must be the only form — so a test that does not
 * care still has to say what happens when something is planted, and what the
 * library holds. */
const ports = {
  panesIn: () => 1,
  plant: async () => ({ armed: [], refused: [] }),
  library: library(),
};

/** A claude pane — the argv path. kimi's file path has its own tests. */
const target: McpInjectionTarget = {
  agentType: "claude",
  cwd: "/repo",
  workspaceId: "ws-1",
  client: "pane-secret",
};

const kimi = (cwd: string): McpInjectionTarget => ({
  agentType: "kimi",
  cwd,
  workspaceId: "ws-1",
  client: "pane-secret",
});

const names = (access: McpAccess) => access.entries.map(({ spec }) => spec.name);
const envOf = (access: McpAccess) => access.entries.flatMap(({ env }) => env);

describe("the MCP injection", () => {
  it("hands out the bundled tier in registry order, then the library", async () => {
    // Order is the precedence: every CLI keys its servers by name and the
    // first claim wins, so a shipped server must be filed before anything the
    // user could name the same.
    const injection = createMcpInjection({
      ...ports,
      contributors: [shipped(), silent],
      library: library(github, local("fs")),
    });

    expect(names(await injection.access(target))).toEqual(["keepdeck", "github", "fs"]);
  });

  it("serves the library even when no bundled server has anything", async () => {
    // The deck's transport being down must not cost the user the servers
    // they configured themselves — the library knows nothing of the socket.
    const injection = createMcpInjection({
      ...ports,
      contributors: [silent],
      library: library(github),
    });

    expect(names(await injection.access(target))).toEqual(["github"]);
  });

  it("gives an argv pane NOTHING when neither tier has anything for it", async () => {
    const plant = vi.fn(async () => ({ armed: [], refused: [] }));
    const injection = createMcpInjection({ ...ports, contributors: [silent], plant });

    const access = await injection.access(target);
    await access.deliver();

    expect(access).toMatchObject({ entries: [], throughArgv: true });
    expect(plant).not.toHaveBeenCalled();
  });

  it("still delivers an EMPTY file to a file-fed pane with nothing in it", async () => {
    // The file IS the delivery. A pane that gets no servers today must not
    // read yesterday's file and keep serving a server the user has since
    // deleted — so the empty set is written like any other.
    const planted: string[] = [];
    const plant = vi.fn(async (_ws: string, _root: string, content: string) => {
      planted.push(content);
      return { armed: ["/repo"], refused: [] };
    });
    const injection = createMcpInjection({ ...ports, contributors: [silent], plant });

    const access = await injection.access(kimi("/repo"));
    await access.deliver();

    expect(access).toMatchObject({ entries: [], throughArgv: false });
    expect(JSON.parse(planted[0]!)).toEqual({ mcpServers: {} });
  });

  it("carries the library's environment — and only for the servers it accepted", async () => {
    // A library entry that lost its name to the bundled tier must not leave
    // its values in the pane either: spec and env are one entry.
    const shadow = local("keepdeck", [["SHADOW", "1"]]);
    const injection = createMcpInjection({
      ...ports,
      contributors: [shipped()],
      library: library(github, shadow),
    });

    const access = await injection.access(target);

    expect(envOf(access)).toEqual([["GH_TOKEN", "ghp_secret"]]);
    // The shipped server kept its name — the library's twin never reached
    // the pane.
    expect(access.entries.find(({ spec }) => spec.name === "keepdeck")?.spec).toMatchObject({
      command: "/bin/keepdeck",
    });
  });

  it("asks the bundled tier with the pane's secret", async () => {
    // The secret is what lets a call be attributed to the pane that made it.
    const keepdeck = shipped();
    const injection = createMcpInjection({ ...ports, contributors: [keepdeck] });

    await injection.access({ ...target, client: "pane-3-secret" });

    expect(keepdeck.asked[0]).toMatchObject({ client: "pane-3-secret", cwd: "/repo" });
  });

  it("asks with NO secret where a file-fed pane shares its directory", async () => {
    // kimi's config is one file per directory. Two panes running there would
    // both announce whichever secret was written last, so the journal would
    // name the wrong pane — worse than naming none.
    const keepdeck = shipped();
    const injection = createMcpInjection({
      ...ports,
      contributors: [keepdeck],
      panesIn: () => 2,
    });

    await injection.access(kimi("/repo"));

    expect(keepdeck.asked[0]?.client).toBeNull();
  });

  it("keeps the secret for an argv agent even where panes share a directory", async () => {
    // Only the FILE is shared. claude/codex/opencode carry their own argv, so
    // a shared cwd costs them nothing.
    const keepdeck = shipped();
    const injection = createMcpInjection({
      ...ports,
      contributors: [keepdeck],
      panesIn: () => 3,
    });

    await injection.access({ ...target, client: "pane-secret" });

    expect(keepdeck.asked[0]?.client).toBe("pane-secret");
  });

  it("keeps kimi's servers OFF the argv and out of the plan's way until asked", async () => {
    // kimi has no flag and no env: its loader reads <cwd>/.kimi-code/mcp.json.
    // Answering is a QUESTION and must write nothing — the plan the answer
    // feeds may still be rejected, and a config for a pane that never spawns
    // is a file the user never asked for.
    const plant = vi.fn(async () => ({ armed: ["/repo"], refused: [] }));
    const injection = createMcpInjection({ ...ports, contributors: [shipped()], plant });

    const access = await injection.access(kimi("/repo"));

    expect(access.throughArgv).toBe(false);
    expect(plant).not.toHaveBeenCalled();
  });

  it("plants a FILE for kimi when the delivery is taken, both tiers in it", async () => {
    const planted: { root: string; content: string }[] = [];
    const plant = vi.fn(
      async (_workspaceId: string, root: string, content: string) => {
        planted.push({ root, content });
        return { armed: [root], refused: [] };
      },
    );
    const injection = createMcpInjection({
      ...ports,
      contributors: [shipped()],
      library: library(github),
      plant,
    });

    const access = await injection.access(kimi("/repo"));
    await access.deliver();

    expect(plant).toHaveBeenCalledWith("ws-1", "/repo", expect.any(String));
    expect(Object.keys(JSON.parse(planted[0]!.content).mcpServers)).toEqual([
      "keepdeck",
      "github",
    ]);
    // The environment rides regardless of the delivery: kimi's children
    // inherit the pane's, file or no file.
    expect(envOf(access)).toEqual([["GH_TOKEN", "ghp_secret"]]);
  });

  it("reports where the config landed", async () => {
    // A root's standing refusal goes with the config that now stands there
    // — and only the caller can tell the consumer it happened.
    const onArmed = vi.fn();
    const injection = createMcpInjection({
      ...ports,
      contributors: [shipped()],
      plant: async () => ({ armed: ["/repo"], refused: [] }),
      onArmed,
    });
    const access = await injection.access(kimi("/repo"));
    await access.deliver();
    expect(onArmed).toHaveBeenCalledWith(["/repo"]);
  });

  it("leaves the argv agents' servers alone — nothing is planted for them", async () => {
    const plant = vi.fn(async () => ({ armed: [], refused: [] }));
    const injection = createMcpInjection({ ...ports, contributors: [shipped()], plant });

    const access = await injection.access(target);
    await access.deliver();

    expect(access.entries).toHaveLength(1);
    expect(access.throughArgv).toBe(true);
    expect(plant).not.toHaveBeenCalled();
  });

  it("a library that cannot be read costs the pane its library servers, not its bundled ones", async () => {
    const injection = createMcpInjection({
      ...ports,
      contributors: [shipped()],
      library: { serversFor: async () => Promise.reject(new Error("disk")) },
    });

    expect(names(await injection.access(target))).toEqual(["keepdeck"]);
  });

  it("a contributor that throws costs the pane that server, not the others", async () => {
    const broken: BundledMcpContributor = {
      name: "broken",
      describe: () => null,
      contribute: async () => Promise.reject(new Error("boom")),
    };
    const injection = createMcpInjection({
      ...ports,
      contributors: [broken, shipped()],
      library: library(github),
    });

    expect(names(await injection.access(target))).toEqual(["keepdeck", "github"]);
  });
});
