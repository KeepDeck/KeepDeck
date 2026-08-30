// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentContribution,
  Disposable,
  McpServerSpec,
  SpawnMcpInput,
  SpawnSkillsInput,
  WorkspaceRef,
} from "@keepdeck/plugin-api";
import {
  BRIDGE_PROTOCOL_VERSION,
  EMPTY_SPAWN_CONTEXT,
  type SpawnPlan,
} from "./plans";
import type { Workspace } from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { createContributionRegistries } from "../../plugins/registries/contributions";
import type { AppRuntime } from "../runtime";
import {
  buildResumeSpec,
  clearPanePlanError,
  dropPaneSpawnSpec,
  peekPanePlanError,
  peekPaneSpawnSpec,
  type SpawnPluginAccess,
  buildLivePaneSpec,
} from ".";
import type { McpAccess } from "./plan";
// Straight from the module: the barrel deliberately does not carry it.
import { resetPaneSpawnSpecs } from "./cache";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const hostState = vi.hoisted(() => ({ installed: [] as unknown[] }));

// Staged skills are a host fact the plan build ASKS for — the worktree manager
// resolves them (and owns which directories get armed), so here it is a thunk
// and tests pick what it answers.
const skillsState = vi.hoisted(() => ({
  views: null as SpawnSkillsInput | null,
}));
const stagedSkills = () => Promise.resolve(skillsState.views);
// MCP access is asked for the same way, and answers with BOTH halves: the
// servers a hook puts on argv, and the on-disk delivery for a CLI that takes
// none. `delivered` records when that write actually happened, which is the
// whole point of it being separate from the answer.
const mcpState = vi.hoisted(() => ({
  servers: [] as McpServerSpec[],
  delivered: [] as string[],
}));
const mcpAccess = (target: { paneId?: string; cwd: string }) =>
  Promise.resolve({
    servers: mcpState.servers,
    deliver: async () => {
      mcpState.delivered.push(target.cwd);
    },
  } satisfies McpAccess);
const pluginRegistries = createContributionRegistries();
const plugins = {
  pluginRegistries,
  pluginHost: { getInstalled: () => hostState.installed },
} as unknown as SpawnPluginAccess;
const runtime = { plugins } as unknown as AppRuntime;

/** A live bridge: the run root, plus the per-pane inbox the host creates
 * before each spawn. The pane's OWN directory is what reaches the agent. */
const ctx = {
  ...EMPTY_SPAWN_CONTEXT,
  bridgeDir: "/bridge/run-1",
  bridgeUrl: "http://127.0.0.1:51611/envelope",
  paneBridgeDir: (paneId: string) => Promise.resolve(`/bridge/run-1/${paneId}`),
};
const W1: WorkspaceRef = { id: "ws-1", instance: "workspace-instance-1" };

/** A claude-shaped agent: reporter args on spawn, --resume on resume. */
const adopting: AgentContribution = {
  id: "claude",
  label: "Claude Code",
  detect: { bin: "claude" },
  hooks: {
    "spawn.plan": (_input, output) => {
      output.args = ["--settings", "{hook}"];
    },
    "resume.plan": (input, output) => {
      output.args = ["--resume", input.sessionId];
    },
  },
};

const ws = (panes: Workspace["panes"]): Workspace[] => [
  {
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "ws",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes,
  },
];

let seen: Record<string, SpawnPlan>;

/** Let the build→cache→tick chain settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};

describe("building one plan through the agent hook", () => {
  let root: Root;
  let registered: Disposable[] = [];

  const register = (agent: AgentContribution) => {
    registered.push(pluginRegistries.agents.add("test-plugin", agent));
  };

  beforeEach(() => {
    resetPaneSpawnSpecs();
    hostState.installed = [];
    skillsState.views = null;
    mcpState.servers = [];
    mcpState.delivered = [];
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
    for (const d of registered) d.dispose();
    registered = [];
  });

  /** Build every live pane's plan, the way the orchestrator's reconcile does,
   *  and collect what landed in the cache. No render: deciding what a pane
   *  runs stopped needing one. */
  const mount = async (
    workspaces: Workspace[],
    context: typeof ctx = ctx,
  ) => {
    for (const workspace of workspaces) {
      for (const pane of workspace.panes) {
        await buildLivePaneSpec(
          runtime.plugins,
          workspace,
          pane,
          context,
          { stagedSkills, mcpAccess },
        );
      }
    }
    seen = {};
    for (const workspace of workspaces) {
      for (const pane of workspace.panes) {
        const spec = peekPaneSpawnSpec(pane.id);
        if (spec) seen[pane.id] = spec;
      }
    }
  };


  it("builds through the hook and arms the bridge on top", async () => {
    register(adopting);
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();

    const plan = seen["pane-1"];
    expect(plan.command).toBe("claude");
    expect(plan.args).toEqual(["--settings", "{hook}"]);
    // Host-owned arming: the ONE bridge var, token echoed in the plan.
    const env = Object.fromEntries(plan.env);
    const bridge = JSON.parse(env.KEEPDECK_BRIDGE);
    // The pane's OWN directory, not the run root: the deck's doorbell is
    // addressed by pane, so a knock meant for another reaches nobody.
    //
    // The version is the CONSTANT, never a literal. Written as `1` here, this
    // assertion did not witness the field — it agreed with a stale value and
    // held it in place while the deck moved on. What ties the constant to the
    // deck's own number, and to every reporter's envelopes, is the pin in
    // scripts/reporterScripts.test.mjs; this checks only that what the app
    // speaks is what it arms panes with.
    expect(bridge).toMatchObject({
      v: BRIDGE_PROTOCOL_VERSION,
      dir: "/bridge/run-1/pane-1",
      pane: "pane-1",
      // The address is the only lane a reporter has; the directory beside it
      // carries the doorbell, which runs the other way.
      url: "http://127.0.0.1:51611/envelope",
    });
    expect(plan.token).toBe(bridge.token);
  });

  it("arms nothing at all when the bridge has no surface", async () => {
    // The address is the only lane a reporter has since the cutoff, so a
    // pane armed without one would spend its whole life reporting into
    // nowhere and looking alive doing it. No var at all is what says so:
    // a reporter finds nothing and stays inert.
    register(adopting);
    await mount(ws([{ id: "pane-1", agentType: "claude" }]), {
      ...ctx,
      bridgeUrl: "",
    });
    await settle();

    const env = Object.fromEntries(seen["pane-1"].env);
    expect(env).not.toHaveProperty("KEEPDECK_BRIDGE");
  });

  it("a pane's YOLO mode reaches the hook input on spawn AND resume", async () => {
    const inputs: Array<boolean | undefined> = [];
    register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          inputs.push(input.yolo);
        },
        "resume.plan": (input) => {
          inputs.push(input.yolo);
        },
      },
    });
    await mount(
      ws([
        { id: "pane-1", agentType: "claude", yolo: true },
        { id: "pane-2", agentType: "claude" },
      ]),
    );
    await settle();
    await buildResumeSpec(
      plugins,
      "claude",
      { paneId: "pane-9", workspace: W1, cwd: "/repo", yolo: true },
      ctx,
      "old-id",
      "restore",
    );
    // Armed pane spawns with it, plain pane WITHOUT it (absent, not false —
    // the wire shapes stay sparse), and a resume carries it the same way.
    expect(inputs.sort()).toEqual([true, true, undefined]);
  });

  it("threads a pane's remoteEndpoint to the hook as a nativeServer target", async () => {
    const targets: Array<unknown> = [];
    register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          targets.push(input.target);
        },
      },
    });
    await mount(
      ws([{ id: "pane-1", agentType: "claude", remoteEndpoint: "ws://vps:4500" }]),
    );
    await settle();
    expect(targets).toEqual([
      { kind: "nativeServer", endpoint: "ws://vps:4500" },
    ]);
  });

  it("omits target when the pane has no remoteEndpoint (local pane)", async () => {
    const targets: Array<unknown> = [];
    register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          targets.push(input.target);
        },
      },
    });
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    expect(targets).toEqual([undefined]);
  });

  it("staged skills reach the hook input on spawn AND resume", async () => {
    skillsState.views = {
      claudePluginDir: "/home/skills/staging/ws-1/claude-plugin",
      opencodeConfigDir: "/home/skills/staging/ws-1/opencode",
      skillsDir: "/home/skills/staging/ws-1/skills",
    };
    const inputs: Array<SpawnSkillsInput | undefined> = [];
    register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          inputs.push(input.skills);
        },
        "resume.plan": (input) => {
          inputs.push(input.skills);
        },
      },
    });
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    await buildResumeSpec(
      plugins,
      "claude",
      { paneId: "pane-9", workspace: W1, cwd: "/repo", stagedSkills, mcpAccess },
      ctx,
      "old-id",
      "restore",
    );
    expect(inputs).toEqual([skillsState.views, skillsState.views]);
  });

  it("MCP servers reach the hook input as a LIST, on spawn AND resume", async () => {
    // A list, not a server: the hook must loop, because the planned bank
    // contributes more members than the built-in transport.
    mcpState.servers = [
      {
        name: "keepdeck",
        transport: "stdio",
        command: "/bin/keepdeck",
        args: ["--mcp-shim", "/sock"],
      },
      {
        name: "mnemo",
        transport: "stdio",
        command: "/bin/mnemo",
        args: [],
      },
    ];
    const inputs: Array<SpawnMcpInput | undefined> = [];
    register({
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
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    await buildResumeSpec(
      plugins,
      "claude",
      { paneId: "pane-9", workspace: W1, cwd: "/repo", stagedSkills, mcpAccess },
      ctx,
      "old-id",
      "restore",
    );
    const expected = { servers: mcpState.servers };
    expect(inputs).toEqual([expected, expected]);
  });

  it("no MCP servers leaves the hook input sparse — nothing to tell apart", async () => {
    // Absent, not an empty list: a hook must not have to tell "the transport
    // is off" apart from "this host is too old to say".
    const inputs: Array<SpawnMcpInput | undefined> = [];
    register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          inputs.push(input.mcp);
        },
      },
    });
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    expect(inputs).toEqual([undefined]);
  });

  it("takes the MCP delivery only AFTER the hook has run", async () => {
    // The file-fed half is a WRITE into the user's working directory, so it
    // waits for a plan that is going to be used. Asking is a question; the
    // answer's delivery is the command, and only this build knows when the
    // plan has settled enough to run it.
    const at: string[] = [];
    register({
      ...adopting,
      hooks: {
        "spawn.plan": () => {
          at.push(`hook, delivered=${mcpState.delivered.length}`);
        },
      },
    });
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();

    expect(at).toEqual(["hook, delivered=0"]);
    expect(mcpState.delivered).toEqual(["/repo"]);
  });

  it("still delivers when a spawn hook threw and the pane degrades to bare", async () => {
    // A bare spawn still RUNS the CLI, and a file-fed one reads its cwd
    // whatever argv it was handed: skipping the write here would leave exactly
    // the panes whose hook failed without any servers at all.
    register({
      ...adopting,
      hooks: {
        "spawn.plan": () => {
          throw new Error("boom");
        },
      },
    });
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();

    expect(seen["pane-1"].args).toEqual([]);
    expect(mcpState.delivered).toEqual(["/repo"]);
  });

  it("plants NOTHING when the build is discarded while it is in flight", async () => {
    // "Is this plan settled?" has two halves: the hook did not throw, and the
    // build's generation still holds. Only the cache knows the second, so the
    // write has to wait for it — otherwise a suspend mid-build leaves a config
    // in the user's directory naming a secret the cache never holds, and the
    // pane it named is not coming back to overwrite it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    register({
      ...adopting,
      hooks: { "spawn.plan": async () => held },
    });
    const workspaces = ws([{ id: "pane-1", agentType: "claude" }]);

    const building = buildLivePaneSpec(
      runtime.plugins,
      workspaces[0],
      workspaces[0].panes[0],
      ctx,
      { stagedSkills, mcpAccess },
    );
    dropPaneSpawnSpec("pane-1"); // the user suspends the pane mid-build
    release();

    expect(await building).toBe(false);
    expect(mcpState.delivered).toEqual([]);
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined();
  });

  it("plants NOTHING for a resume whose hook rejected the plan", async () => {
    // A resume that throws propagates — no process will ever start — so a
    // config naming that pane is a file in the user's repository that nothing
    // asked for and nothing would take away.
    register({
      ...adopting,
      hooks: {
        "resume.plan": () => {
          throw new Error("no such session");
        },
      },
    });

    await expect(
      buildResumeSpec(
        plugins,
        "claude",
        { paneId: "pane-9", workspace: W1, cwd: "/repo", stagedSkills, mcpAccess },
        ctx,
        "old-id",
        "restore",
      ),
    ).rejects.toThrow("no such session");

    expect(mcpState.delivered).toEqual([]);
  });

  it("an empty library leaves the hook input sparse — no skills key at all", async () => {
    const sawKey: boolean[] = [];
    register({
      ...adopting,
      hooks: {
        "spawn.plan": (input) => {
          sawKey.push("skills" in input);
        },
      },
    });
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    expect(sawKey).toEqual([false]);
  });

  it("builds each pane ONCE — a re-render must not re-mint", async () => {
    register(adopting);
    const workspaces = ws([{ id: "pane-1", agentType: "claude" }]);
    await mount(workspaces);
    await settle();
    const first = seen["pane-1"];

    await mount([...workspaces]); // new array identity → effect re-runs
    await settle();
    expect(seen["pane-1"]).toBe(first);
  });

  it("skips idle, provisioning and unknown-agent panes", async () => {
    register(adopting);
    await mount(
      ws([
        {
          id: "pane-d",
          agentType: "claude",
          idle: { reason: "waking", origin: "restore" },
        },
        {
          id: "pane-p",
          agentType: "claude",
          provisioning: { repo: "/r", path: "/b/w-1", workspace: "w", index: 1 },
        },
        { id: "pane-u", agentType: "gemini" },
      ]),
    );
    await settle();
    expect(seen).toEqual({});
  });

  it("a throwing hook degrades to a bare spawn, not a dead pane", async () => {
    register({
      ...adopting,
      hooks: {
        "spawn.plan": () => {
          throw new Error("boom");
        },
      },
    });
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();

    // Bare, but not anonymous: a kimi pane's config is planted before a hook
    // can throw and names this secret, so dropping it would lose the pane's
    // identity rather than degrade its spawn.
    expect(seen["pane-1"]).toEqual({
      command: "claude",
      args: [],
      env: [],
      mcpToken: expect.any(String),
    });
  });

  it("a throwing REMOTE spawn.plan does NOT degrade to a bare local spawn", async () => {
    // A bare spawn for a remote pane would run the agent LOCALLY, silently
    // dropping the endpoint — a wrong-target execution. The error must surface
    // instead (no plan lands), unlike the local degradation above.
    register({
      ...adopting,
      hooks: {
        "spawn.plan": () => {
          throw new Error("boom");
        },
      },
    });
    await mount(
      ws([{ id: "pane-1", agentType: "claude", remoteEndpoint: "ws://vps:4500" }]),
    );
    await settle();

    expect(seen["pane-1"]).toBeUndefined();
    // The failure is recorded so the deck can show an error tile (with a
    // retry) instead of hanging on "Waking up…" forever.
    expect(peekPanePlanError("pane-1")).toBe(true);
    clearPanePlanError("pane-1");
    expect(peekPanePlanError("pane-1")).toBe(false);
  });

  it("reports a failed build as a CHANGE, so the error tile can replace the spinner", async () => {
    // The failure has to count as a cache change: its consumer decides
    // between the error tile and "Waking up…" from what the cache says, and a
    // build that failed silently would leave the pane on the spinner until
    // some unrelated event happened along.
    register({
      ...adopting,
      hooks: {
        "spawn.plan": () => {
          throw new Error("boom");
        },
      },
    });
    const workspaces = ws([
      { id: "pane-1", agentType: "claude", remoteEndpoint: "ws://vps:4500" },
    ]);
    const changed = await buildLivePaneSpec(
      runtime.plugins,
      workspaces[0],
      workspaces[0].panes[0],
      ctx,
      { stagedSkills, mcpAccess },
    );

    // A failure is a CHANGE, and saying so is what gets the error tile drawn:
    // reported as "nothing happened", the pane would sit on "Waking up…" until
    // something unrelated redrew the deck.
    expect(changed).toBe(true);
    expect(peekPanePlanError("pane-1")).toBe(true);
  });

  it("an EXTERNAL plugin's off-capability command is clamped to its binary", async () => {
    // The hook picked a program its manifest never declared — a sandboxed
    // plugin must not choose the spawn target. Built-ins only warn.
    hostState.installed = [
      {
        manifest: {
          id: "test-plugin",
          capabilities: [{ kind: "exec", commands: ["claude"] }],
        },
        source: "external",
        status: { kind: "active" },
      },
    ];
    register({
      ...adopting,
      hooks: {
        "spawn.plan": (_input, output) => {
          output.command = "curl";
          output.args = ["evil.sh"];
        },
      },
    });
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();

    expect(seen["pane-1"].command).toBe("claude"); // detect.bin, declared
    expect(seen["pane-1"].args).toEqual([]);
  });
});
