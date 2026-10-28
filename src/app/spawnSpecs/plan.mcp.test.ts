// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_HTTP_API, type SpawnMcpInput } from "@keepdeck/plugin-api";
import { log } from "../../ipc/log";
import { buildResumeSpec, dropPaneSpawnSpec } from ".";
import {
  hostState,
  stagedSkills,
  mcpState,
  local,
  GH_TOKEN,
  github,
  specsOf,
  mcpAccess,
  plugins,
  installedPlugin,
  ctx,
  W1,
  adopting,
  ws,
  settle,
  planHarness,
} from "./planTestSupport";
import { present } from "@keepdeck/plugin-api/testing";

/**
 * MCP through the plan: what the hook is told, what the pane's environment
 * carries, and when the file-fed delivery is taken. The rest of the build is
 * `plan.test.ts`; the harness is shared.
 */
describe("MCP servers through the plan", () => {
  const h = planHarness();

  beforeEach(() => h.reset());
  afterEach(() => h.teardown());

  it("MCP servers reach the hook input as a LIST, on spawn AND resume", async () => {
    // A list, not a server: the hook must loop, because the planned bank
    // contributes more members than the built-in transport.
    mcpState.entries = [
      local("keepdeck", "/bin/keepdeck", ["--mcp-shim", "/sock"]),
      local("mnemo", "/bin/mnemo"),
    ];
    const inputs: Array<SpawnMcpInput | undefined> = [];
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          inputs.push(input.mcp);
        },
        "resume.plan": (input) => {
          inputs.push(input.mcp);
        },
      },
    });
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    await buildResumeSpec(
      plugins,
      "claude",
      { paneId: "pane-9", workspace: W1, cwd: "/repo", stagedSkills, mcpAccess },
      ctx,
      "old-id",
      "restore",
    );
    const expected = { servers: specsOf(mcpState.entries) };
    expect(inputs).toEqual([expected, expected]);
  });

  it("withholds remote servers from an external plugin whose floor predates them", async () => {
    // That plugin's renderer throws on the arm, and a throwing spawn hook
    // costs the pane EVERY server — so the local ones still reach it, and
    // only the remote one is held back. Held back WHOLE: a server the pane
    // never hears of must not leave its token in the pane's environment.
    mcpState.entries = [local("keepdeck", "/bin/keepdeck"), github];
    const inputs: Array<SpawnMcpInput | undefined> = [];
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          inputs.push(input.mcp);
        },
      },
    });
    const external = (minApiVersion: number) =>
      installedPlugin({
        source: "external",
        minApiVersion,
        capabilities: [{ kind: "exec", commands: ["claude"] }],
      });

    hostState.installed = [external(MCP_HTTP_API - 1)];
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    expect(inputs).toEqual([{ servers: [present(mcpState.entries[0], "the first MCP entry").spec] }]);
    expect(h.seen["pane-1"].env).not.toContainEqual(GH_TOKEN);

    // A floor at the arm's revision, and everything reaches the hook.
    dropPaneSpawnSpec("pane-1");
    hostState.installed = [external(MCP_HTTP_API)];
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    expect(inputs[1]).toEqual({ servers: specsOf(mcpState.entries) });
    expect(h.seen["pane-1"].env).toContainEqual(GH_TOKEN);
  });

  it("every agent's plugin is handed the servers — one fed by a file renders that file itself", async () => {
    // The host renders no CLI's config: argv, env or a file in the cwd is
    // the plugin's to make from the same list. What the specs only NAME is
    // owed to the pane's environment all the same.
    mcpState.entries = [github];
    const inputs: Array<SpawnMcpInput | undefined> = [];
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": () => {},
        "arm.plan": (input) => {
          inputs.push(input.mcp);
        },
      },
    });
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    expect(inputs).toEqual([{ servers: [github.spec] }]);
    expect(h.seen["pane-1"].env).toContainEqual(GH_TOKEN);
  });

  it("the pane's own variables win over a server's, and the clash is logged", async () => {
    // The plugin's and the host's variables carry the pane's identity and
    // config. A server whose file happens to name one of them must not
    // displace it for the whole pane — the PTY applies pairs last-wins, so
    // the server's pair goes first.
    const warned = vi.spyOn(log, "warn").mockImplementation(() => {});
    mcpState.entries = [{ ...github, env: [["CLAUDE_CONFIG_DIR", "/from-server"]] }];
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": (_input, output) => {
          output.env = [["CLAUDE_CONFIG_DIR", "/from-plugin"]];
        },
      },
    });
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    const names = h.seen["pane-1"].env.map(([name]) => name);
    expect(names.indexOf("CLAUDE_CONFIG_DIR")).toBeLessThan(
      names.lastIndexOf("CLAUDE_CONFIG_DIR"),
    );
    const dirs = h.seen["pane-1"].env.filter(([name]) => name === "CLAUDE_CONFIG_DIR");
    expect(dirs[dirs.length - 1]).toEqual(["CLAUDE_CONFIG_DIR", "/from-plugin"]);
    expect(warned).toHaveBeenCalledWith(
      "web:agents",
      expect.stringContaining("CLAUDE_CONFIG_DIR"),
    );
    warned.mockRestore();
  });

  it("what the servers need in the environment reaches the plan — even a bare one", async () => {
    // The values a spec only NAMES live nowhere but here, and a file-fed CLI
    // reads its servers from its cwd whatever argv it got: a hook that threw
    // still yields a plan whose environment carries them.
    mcpState.entries = [github];
    h.register(adopting);
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    expect(h.seen["pane-1"].env).toContainEqual(["GH_TOKEN", "ghp_secret"]);

    dropPaneSpawnSpec("pane-1");
    h.disposeAgents();
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": () => {
          throw new Error("hook broke");
        },
      },
    });
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    expect(h.seen["pane-1"].args).toEqual([]);
    expect(h.seen["pane-1"].env).toContainEqual(["GH_TOKEN", "ghp_secret"]);
  });

  it("no MCP servers leaves the hook input sparse — nothing to tell apart", async () => {
    // Absent, not an empty list: a hook must not have to tell "the transport
    // is off" apart from "this host is too old to say".
    const inputs: Array<SpawnMcpInput | undefined> = [];
    h.register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          inputs.push(input.mcp);
        },
      },
    });
    await h.mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    expect(inputs).toEqual([undefined]);
  });

});
