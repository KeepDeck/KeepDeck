// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContribution, Disposable } from "@keepdeck/plugin-api";
import { EMPTY_SPAWN_CONTEXT, type SpawnPlan } from "../domain/agents";
import type { Workspace } from "../domain/deck";
import { pluginRegistries } from "./pluginManager";
import {
  buildResumeSpec,
  peekPaneSpawnSpec,
  resetPaneSpawnSpecs,
  usePaneSpawnSpecs,
} from "./spawnSpecs";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("./pluginManager", async () => {
  const { createContributionRegistries } = await import(
    "../plugins/registries/contributions"
  );
  return {
    pluginRegistries: createContributionRegistries(),
    bootstrapPlugins: () => Promise.resolve(),
  };
});

const ctx = { ...EMPTY_SPAWN_CONTEXT, bridgeDir: "/bridge/run-1" };

/** An adopting agent (claude-shaped): echoes the pre-minted id. */
const adopting: AgentContribution = {
  id: "claude",
  label: "Claude Code",
  detect: { bin: "claude" },
  hooks: {
    "spawn.plan": (input, output) => {
      output.args = ["--session-id", input.sessionId];
      output.sessionId = input.sessionId;
    },
    "resume.plan": (input, output) => {
      output.args = ["--resume", input.sessionId];
    },
  },
};

const ws = (panes: Workspace["panes"]): Workspace[] => [
  { id: "ws-1", name: "ws", cwd: "/repo", worktreeBaseDir: null, panes },
];

let seen: Record<string, SpawnPlan>;
function Probe({ workspaces }: { workspaces: Workspace[] }) {
  seen = usePaneSpawnSpecs(workspaces, ctx, true);
  return null;
}

/** Let the build→cache→tick chain settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};

describe("the spawn-plan pipeline (plugin hooks + host bridge arming)", () => {
  let root: Root;
  let registered: Disposable[] = [];

  const register = (agent: AgentContribution) => {
    registered.push(pluginRegistries.agents.add("test-plugin", agent));
  };

  beforeEach(() => {
    resetPaneSpawnSpecs();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
    for (const d of registered) d.dispose();
    registered = [];
  });

  const mount = (workspaces: Workspace[]) =>
    act(async () => root.render(createElement(Probe, { workspaces })));

  it("builds through the hook and arms the bridge on top", async () => {
    register(adopting);
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();

    const plan = seen["pane-1"];
    expect(plan.command).toBe("claude");
    expect(plan.args.slice(0, 1)).toEqual(["--session-id"]);
    // The hook adopted the minted id — bind immediately.
    expect(plan.sessionId).toBe(plan.args[1]);
    // Host-owned arming: the ONE bridge var, token echoed in the plan.
    const env = Object.fromEntries(plan.env);
    const bridge = JSON.parse(env.KEEPDECK_BRIDGE);
    expect(bridge).toMatchObject({ v: 1, dir: "/bridge/run-1", pane: "pane-1" });
    expect(plan.token).toBe(bridge.token);
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

  it("skips dormant, provisioning and unknown-agent panes", async () => {
    register(adopting);
    await mount(
      ws([
        { id: "pane-d", agentType: "claude", dormant: true },
        {
          id: "pane-p",
          agentType: "claude",
          provisioning: { repo: "/r", baseDir: "/b", workspace: "w", index: 1 },
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

    expect(seen["pane-1"]).toEqual({ command: "claude", args: [], env: [] });
  });

  it("buildResumeSpec caches a resume plan the wake can read back", async () => {
    register(adopting);
    await buildResumeSpec("claude", "pane-9", "ws-1", "/repo", undefined, ctx, "old-id");
    expect(peekPaneSpawnSpec("pane-9")?.args).toEqual(["--resume", "old-id"]);
    // Resume never adopts — the binding is already recorded.
    expect(peekPaneSpawnSpec("pane-9")?.sessionId).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-9")?.token).toBeDefined();
  });
});
