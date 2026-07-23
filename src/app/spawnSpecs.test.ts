// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentContribution,
  Disposable,
  SpawnSkillsInput,
  WorkspaceRef,
} from "@keepdeck/plugin-api";
import { EMPTY_SPAWN_CONTEXT, type SpawnPlan } from "../domain/agents";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { createContributionRegistries } from "../plugins/registries/contributions";
import type { AppRuntime } from "./runtime";
import { AppRuntimeProvider } from "./runtimeContext";
import { invalidateSkillsStaging } from "./skillsStaging";
import {
  buildResumeSpec,
  clearPanePlanError,
  dropPaneSpawnSpec,
  peekPanePlanError,
  peekPaneSpawnSpec,
  resetPaneSpawnSpecs,
  resumeDiedSilently,
  type SpawnPluginAccess,
  usePaneSpawnSpecs,
} from "./spawnSpecs";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const hostState = vi.hoisted(() => ({ installed: [] as unknown[] }));

// Staged skills are a host fact fetched through the staging memo; the wire
// behind it is stubbed so tests pick what the "library" holds.
const skillsState = vi.hoisted(() => ({
  views: null as SpawnSkillsInput | null,
}));
vi.mock("../ipc/skills", () => ({
  stageSkills: vi.fn(async () => skillsState.views),
}));
const pluginRegistries = createContributionRegistries();
const plugins = {
  pluginRegistries,
  pluginHost: { getInstalled: () => hostState.installed },
} as unknown as SpawnPluginAccess;
const runtime = { plugins } as unknown as AppRuntime;

const ctx = { ...EMPTY_SPAWN_CONTEXT, bridgeDir: "/bridge/run-1" };
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
    hostState.installed = [];
    skillsState.views = null;
    invalidateSkillsStaging();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
    for (const d of registered) d.dispose();
    registered = [];
  });

  const mount = (workspaces: Workspace[]) =>
    act(async () =>
      root.render(
        createElement(
          AppRuntimeProvider,
          { runtime },
          createElement(Probe, { workspaces }),
        ),
      ),
    );

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
    expect(bridge).toMatchObject({
      v: 1,
      dir: "/bridge/run-1",
      pane: "pane-1",
    });
    expect(plan.token).toBe(bridge.token);
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
      { paneId: "pane-9", workspace: W1, cwd: "/repo" },
      ctx,
      "old-id",
      "restore",
    );
    expect(inputs).toEqual([skillsState.views, skillsState.views]);
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

  it("a failed build re-renders consumers (bumps the snapshot tick)", async () => {
    // The .catch must bump the snapshot tick, else the memo never refreshes
    // and DeckStage never re-reads peekPanePlanError — the pane would hang on
    // "Waking up…" until some unrelated re-render (the bug r3 caught). A
    // render-counting probe observes the re-render directly: with the fix the
    // failed build triggers a second render; without it, renders stays at 1.
    register({
      ...adopting,
      hooks: {
        "spawn.plan": () => {
          throw new Error("boom");
        },
      },
    });
    let renders = 0;
    const CountProbe = ({ workspaces }: { workspaces: Workspace[] }) => {
      usePaneSpawnSpecs(workspaces, ctx, true);
      renders++;
      return null;
    };
    await act(async () =>
      root.render(
        createElement(
          AppRuntimeProvider,
          { runtime },
          createElement(CountProbe, {
            workspaces: ws([
              { id: "pane-1", agentType: "claude", remoteEndpoint: "ws://vps:4500" },
            ]),
          }),
        ),
      ),
    );
    await settle();
    expect(renders).toBeGreaterThan(1);
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

  it("buildResumeSpec caches a resume plan the wake can read back", async () => {
    register(adopting);
    await buildResumeSpec(
      plugins,
      "claude",
      { paneId: "pane-9", workspace: W1, cwd: "/repo" },
      ctx,
      "old-id",
      "restore",
    );
    expect(peekPaneSpawnSpec("pane-9")?.args).toEqual(["--resume", "old-id"]);
    expect(peekPaneSpawnSpec("pane-9")?.token).toBeDefined();
    // The failure detector's bookkeeping rides the plan.
    expect(peekPaneSpawnSpec("pane-9")?.resumeOf).toBe("old-id");
    expect(peekPaneSpawnSpec("pane-9")?.resumeOrigin).toBe("restore");
    expect(peekPaneSpawnSpec("pane-9")?.postbackMark).toBe(0);
  });

  it("refuses to label a bare spawn as a manual resume", async () => {
    register({
      ...adopting,
      hooks: { "spawn.plan": adopting.hooks["spawn.plan"] },
    });

    const built = await buildResumeSpec(
      plugins,
      "claude",
      { paneId: "pane-unsupported", workspace: W1, cwd: "/repo" },
      ctx,
      "old-id",
      "manual",
    );

    expect(built).toBe(false);
    expect(peekPaneSpawnSpec("pane-unsupported")).toBeUndefined();
  });

  it("reserves a manual resume so the fresh-plan sweep cannot overwrite it", async () => {
    let releaseResume!: () => void;
    let spawnCalls = 0;
    register({
      ...adopting,
      hooks: {
        "spawn.plan": async (_input, output) => {
          spawnCalls += 1;
          // A racy second fresh build stays pending long enough to overwrite
          // the manual plan after it lands; the reservation prevents it from
          // starting in the first place.
          if (spawnCalls > 1) await new Promise<void>(() => {});
          output.args = ["--settings", "{hook}"];
        },
        "resume.plan": async (input, output) => {
          await new Promise<void>((resolve) => (releaseResume = resolve));
          output.args = ["--resume", input.sessionId];
        },
      },
    });
    const workspaces = ws([{ id: "pane-1", agentType: "claude" }]);
    await mount(workspaces);
    await settle();
    expect(spawnCalls).toBe(1);

    dropPaneSpawnSpec("pane-1");
    const manual = buildResumeSpec(
      plugins,
      "claude",
      { paneId: "pane-1", workspace: W1, cwd: "/repo" },
      ctx,
      "old-id",
      "manual",
    );
    // An unrelated deck render re-runs the ordinary plan sweep while the
    // plugin's async resume hook is still waiting.
    await mount([...workspaces]);
    expect(spawnCalls).toBe(1);

    releaseResume();
    await manual;
    await settle();
    expect(peekPaneSpawnSpec("pane-1")).toMatchObject({
      args: ["--resume", "old-id"],
      resumeOf: "old-id",
      resumeOrigin: "manual",
    });
  });

  it("does not install an async resume plan invalidated while it was building", async () => {
    let releaseResume: (() => void) | undefined;
    register({
      ...adopting,
      hooks: {
        "resume.plan": async (input, output) => {
          await new Promise<void>((resolve) => (releaseResume = resolve));
          output.args = ["--resume", input.sessionId];
        },
      },
    });

    const building = buildResumeSpec(
      plugins,
      "claude",
      { paneId: "pane-1", workspace: W1, cwd: "/repo" },
      ctx,
      "old-id",
      "manual",
    );
    // The plan build awaits host facts (staged skills) before entering the
    // hook — wait for the hook to be mid-flight, then invalidate under it.
    await vi.waitFor(() => {
      if (!releaseResume) throw new Error("hook not entered yet");
    });
    dropPaneSpawnSpec("pane-1");
    releaseResume!();
    await building;

    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined();
  });

  it("resumeDiedSilently: only a restored resume with ZERO new postbacks retries", () => {
    const restored = {
      args: [],
      env: [],
      resumeOf: "old",
      resumeOrigin: "restore" as const,
      postbackMark: 2,
    };
    // Exited with the count unmoved — the CLI refused the id: retry fresh.
    expect(resumeDiedSilently(restored, 2)).toBe(true);
    // A postback arrived — the session really started; a later exit is real.
    expect(resumeDiedSilently(restored, 3)).toBe(false);
    // A manual restart is never silently replaced with another spawn.
    expect(resumeDiedSilently({ ...restored, resumeOrigin: "manual" }, 2)).toBe(
      false,
    );
    // Fresh plans and unknown panes never retry.
    expect(resumeDiedSilently({ args: [], env: [] }, 0)).toBe(false);
    expect(resumeDiedSilently(undefined, 0)).toBe(false);
  });
});
