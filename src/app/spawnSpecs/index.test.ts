// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentContribution,
  Disposable,
  SpawnSkillsInput,
  WorkspaceRef,
} from "@keepdeck/plugin-api";
import { EMPTY_SPAWN_CONTEXT, type SpawnPlan } from "./plans";
import type { Workspace } from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { createContributionRegistries } from "../../plugins/registries/contributions";
import type { AppRuntime } from "../runtime";
import {
  bindPaneSpawnSpecSession,
  buildForkSpec,
  buildResumeSpec,
  dropPaneSpawnSpec,
  markPaneResumeOrigin,
  peekPaneSpawnSpec,
  resumeDiedSilently,
  spawnPlanInheritsSession,
  spawnPlanNeedsUsageBaseline,
  type SpawnPluginAccess,
  buildLivePaneSpec,
} from ".";
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

/** Let the build→cache→tick chain settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};

describe("the plan builders — live pane, resume, fork", () => {
  let root: Root;
  let registered: Disposable[] = [];

  const register = (agent: AgentContribution) => {
    registered.push(pluginRegistries.agents.add("test-plugin", agent));
  };

  beforeEach(() => {
    resetPaneSpawnSpecs();
    hostState.installed = [];
    skillsState.views = null;
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
  const mount = async (workspaces: Workspace[]) => {
    for (const workspace of workspaces) {
      for (const pane of workspace.panes) {
        await buildLivePaneSpec(
          runtime.plugins,
          workspace,
          pane,
          ctx,
          { stagedSkills },
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

  it("records a fork's source and binds only its first reported session", async () => {
    register({
      ...adopting,
      hooks: {
        ...adopting.hooks,
        "fork.plan": (input, output) => {
          output.args = ["--fork", input.sessionId];
        },
      },
    });

    await buildForkSpec(
      plugins,
      "claude",
      { paneId: "pane-fork", workspace: W1, cwd: "/repo" },
      ctx,
      { sessionId: "source-id", sourceCwd: "/repo" },
    );

    expect(peekPaneSpawnSpec("pane-fork")).toMatchObject({
      forkOf: "source-id",
      args: ["--fork", "source-id"],
    });
    bindPaneSpawnSpecSession("pane-fork", "fork-id");
    bindPaneSpawnSpecSession("pane-fork", "later-new-id");
    expect(peekPaneSpawnSpec("pane-fork")?.forkSessionId).toBe("fork-id");
    expect(
      spawnPlanNeedsUsageBaseline(peekPaneSpawnSpec("pane-fork"), "fork-id"),
    ).toBe(true);
    expect(
      spawnPlanNeedsUsageBaseline(
        peekPaneSpawnSpec("pane-fork"),
        "later-new-id",
      ),
    ).toBe(false);
    expect(
      spawnPlanNeedsUsageBaseline({ resumeOf: "resumed-id" }, "resumed-id"),
    ).toBe(true);
  });

  it("says a plan inherits even before the id it inherits is bound", async () => {
    // The window the ledger cares about. A fork carries `forkOf` from the
    // moment it is built and gains `forkSessionId` only when the binding
    // lands — and a usage report can overtake that envelope. Reading the
    // unmatched pair as "started clean" there told the ledger a cloned
    // transcript was brand-new usage and appended the whole conversation.
    expect(spawnPlanInheritsSession({ forkOf: "source-id" })).toBe(true);
    expect(spawnPlanInheritsSession({ resumeOf: "resumed-id" })).toBe(true);
    expect(spawnPlanInheritsSession({ forkSessionId: "fork-id" })).toBe(true);
    // A bare spawn is the only thing that starts clean, and only a plan that
    // exists says anything at all.
    expect(spawnPlanInheritsSession({})).toBe(false);
    expect(spawnPlanInheritsSession(undefined)).toBe(false);
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

  it("re-stamps a cached RESUME plan and leaves everything else about it alone", async () => {
    // The origin arms (or disarms) the one-shot fall back to a fresh
    // conversation, and it is the only field a mid-build change of requester
    // needs to alter — the agent's `resume.plan` hook never sees it, so
    // rebuilding would re-run a third party's code for nothing.
    register(adopting);
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    await buildResumeSpec(
      plugins,
      "claude",
      { paneId: "pane-1", workspace: W1, cwd: "/repo" },
      ctx,
      "old-id",
      "restore",
    );
    const before = peekPaneSpawnSpec("pane-1")!;
    expect(before.resumeOrigin).toBe("restore");

    markPaneResumeOrigin("pane-1", "manual");

    const after = peekPaneSpawnSpec("pane-1")!;
    expect(after.resumeOrigin).toBe("manual");
    // Same plan otherwise: the args the CLI runs, the bridge token its
    // reporter echoes, and the resume key all have to survive untouched.
    expect(after.args).toEqual(before.args);
    expect(after.token).toBe(before.token);
    expect(after.resumeOf).toBe(before.resumeOf);
    // And the flip disarms the auto-fresh fallback, which is the point.
    expect(resumeDiedSilently(after, after.postbackMark ?? 0)).toBe(false);
  });

  it("refuses a plan that is not a resume, and a pane with no plan at all", async () => {
    // A fresh or forked plan has no requester to re-stamp; stamping one would
    // put a resume field on a plan that never resumes anything.
    register(adopting);
    await mount(ws([{ id: "pane-1", agentType: "claude" }]));
    await settle();
    const fresh = peekPaneSpawnSpec("pane-1");
    expect(fresh?.resumeOf).toBeUndefined();

    markPaneResumeOrigin("pane-1", "manual");
    expect(peekPaneSpawnSpec("pane-1")?.resumeOrigin).toBeUndefined();

    // A dropped (or never-built) plan must not be resurrected by a stamp.
    dropPaneSpawnSpec("pane-1");
    markPaneResumeOrigin("pane-1", "manual");
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined();
  });
});
