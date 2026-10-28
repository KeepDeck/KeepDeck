import { describe, expect, it } from "vitest";
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

/** An agent whose plugin declares it takes its servers through a file in its
 * cwd; every other agent here takes them some other way. */
const FILE_FED = "file-fed";

/** The ports every construction needs. `library` is required by design, so a
 * test that does not care still has to say what the library holds. */
const ports = {
  panesIn: () => 1,
  deliversByCwd: (agentType: string) => agentType === FILE_FED,
  library: library(),
};

/** A pane of an agent that renders its servers onto its argv. */
const target: McpInjectionTarget = {
  agentType: "argv-fed",
  cwd: "/repo",
  workspaceId: "ws-1",
  client: "pane-secret",
};

const fileFed = (cwd: string): McpInjectionTarget => ({
  agentType: FILE_FED,
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

  it("gives a pane NOTHING when neither tier has anything for it", async () => {
    const injection = createMcpInjection({ ...ports, contributors: [silent] });
    expect(await injection.access(target)).toEqual({ entries: [] });
    expect(await injection.access(fileFed("/repo"))).toEqual({ entries: [] });
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
    // A config in the cwd is one file per directory. Two panes running there
    // would both announce whichever secret was written last, so the journal
    // would name the wrong pane — worse than naming none.
    const keepdeck = shipped();
    const injection = createMcpInjection({
      ...ports,
      contributors: [keepdeck],
      panesIn: () => 2,
    });

    await injection.access(fileFed("/repo"));

    expect(keepdeck.asked[0]?.client).toBeNull();
  });

  it("keeps the secret for a file-fed pane alone in its directory", async () => {
    const keepdeck = shipped();
    const injection = createMcpInjection({ ...ports, contributors: [keepdeck], panesIn: () => 1 });
    await injection.access(fileFed("/repo"));
    expect(keepdeck.asked[0]?.client).toBe("pane-secret");
  });

  it("keeps the secret for an argv agent even where panes share a directory", async () => {
    // Only the FILE is shared. An agent that carries its servers on its own
    // argv loses nothing to a shared cwd.
    const keepdeck = shipped();
    const injection = createMcpInjection({
      ...ports,
      contributors: [keepdeck],
      panesIn: () => 3,
    });

    await injection.access({ ...target, client: "pane-secret" });

    expect(keepdeck.asked[0]?.client).toBe("pane-secret");
  });

  it("answers a file-fed pane with the same servers and values — the file is its plugin's to render", async () => {
    const injection = createMcpInjection({ ...ports, contributors: [shipped()], library: library(github) });
    const access = await injection.access(fileFed("/repo"));
    expect(names(access)).toEqual(["keepdeck", "github"]);
    // Its children inherit the pane's environment, file or no file.
    expect(envOf(access)).toEqual([["GH_TOKEN", "ghp_secret"]]);
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
