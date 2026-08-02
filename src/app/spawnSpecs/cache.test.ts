// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentContribution,
  Disposable,
  SpawnSkillsInput,
  WorkspaceRef,
} from "@keepdeck/plugin-api";
import { EMPTY_SPAWN_CONTEXT } from "./plans";
import type { Workspace } from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { createContributionRegistries } from "../../plugins/registries/contributions";
import {
  buildForkSpec,
  buildResumeSpec,
  clearPanePlanError,
  dropPaneSpawnSpec,
  markPaneResumeOrigin,
  peekPanePlanError,
  peekPaneSpawnSpec,
  resetPaneSpawnSpecs,
  type SpawnPluginAccess,
  buildLivePaneSpec,
  paneIdByMcpToken,
  subscribeSpawnSpecs,
} from ".";

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

describe("subscribeSpawnSpecs — the cache tells its readers", () => {
  // Tested against the REAL module deliberately. The orchestrator's own suite
  // replaces this module with a fake, so nothing there can prove a writer
  // notifies — and the writers reached through an await are exactly the ones
  // that silently did not, leaving a resumed pane with a live process and a
  // view that never learned its plan existed.
  let registered: Disposable[] = [];
  let heard: number;
  let stop: () => void;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    hostState.installed = [];
    registered.push(pluginRegistries.agents.add("test-plugin", adopting));
    heard = 0;
    stop = subscribeSpawnSpecs(() => {
      heard += 1;
    });
  });

  afterEach(() => {
    stop();
    for (const entry of registered) entry.dispose();
    registered = [];
  });

  const facts = { paneId: "pane-1", workspace: W1, cwd: "/repo" };

  it("announces a plan built by the ordinary sweep", async () => {
    await buildLivePaneSpec(
      plugins,
      ws([{ id: "pane-1", agentType: "claude" }])[0],
      { id: "pane-1", agentType: "claude" },
      ctx,
      { stagedSkills },
    );
    expect(heard).toBeGreaterThan(0);
  });

  it("announces a RESUME plan — the path that regressed", async () => {
    // A resume fills the cache directly, so the sweep's own rebuild
    // short-circuits and cannot be the thing that publishes.
    await buildResumeSpec(plugins, "claude", facts, ctx, "s-1", "manual");
    expect(heard).toBeGreaterThan(0);
  });

  it("announces a FORK plan", async () => {
    registered.push(
      pluginRegistries.agents.add("test-plugin", {
        id: "forker",
        label: "Forker",
        detect: { bin: "forker" },
        hooks: {
          "fork.plan": (input, output) => {
            output.args = ["--fork", input.sessionId];
          },
        },
      }),
    );
    await buildForkSpec(plugins, "forker", facts, ctx, {
      sessionId: "s-1",
      sourceCwd: "/old",
    });
    expect(peekPaneSpawnSpec("pane-1")).toBeDefined();
    expect(heard).toBeGreaterThan(0);
  });

  it("stays SILENT when a plan could not be prepared at all", async () => {
    // No fork hook: nothing is cached, so there is nothing to announce and a
    // listener must not be woken to find the cache unchanged.
    expect(
      await buildForkSpec(plugins, "claude", facts, ctx, {
        sessionId: "s-1",
        sourceCwd: "/old",
      }),
    ).toBe(false);
    expect(heard).toBe(0);
  });

  it("announces a plan being dropped", async () => {
    await buildResumeSpec(plugins, "claude", facts, ctx, "s-1", "manual");
    heard = 0;
    dropPaneSpawnSpec("pane-1");
    expect(heard).toBe(1);
  });

  it("announces a build FAILURE, so the error tile can replace the placeholder", async () => {
    registered.push(
      pluginRegistries.agents.add("test-plugin", {
        id: "throws",
        label: "Throws",
        detect: { bin: "throws" },
        hooks: {
          "resume.plan": () => {
            throw new Error("hook exploded");
          },
        },
      }),
    );
    await expect(
      buildResumeSpec(plugins, "throws", { ...facts, paneId: "pane-2" }, ctx, "s-2", "manual"),
    ).rejects.toThrow("hook exploded");
    expect(peekPanePlanError("pane-2")).toBe(true);
    expect(heard).toBeGreaterThan(0);
  });

  it("announces a failure being cleared, so a retry can rebuild", async () => {
    registered.push(
      pluginRegistries.agents.add("test-plugin", {
        id: "throws2",
        label: "Throws",
        detect: { bin: "throws2" },
        hooks: {
          "resume.plan": () => {
            throw new Error("boom");
          },
        },
      }),
    );
    await expect(
      buildResumeSpec(plugins, "throws2", { ...facts, paneId: "pane-3" }, ctx, "s-3", "manual"),
    ).rejects.toThrow();
    heard = 0;
    clearPanePlanError("pane-3");
    expect(heard).toBe(1);
  });

  it("announces a re-stamped resume origin", async () => {
    await buildResumeSpec(plugins, "claude", facts, ctx, "s-1", "restore");
    heard = 0;
    markPaneResumeOrigin("pane-1", "manual");
    expect(heard).toBe(1);
  });

  it("lets a listener go, and forgets every listener on reset", async () => {
    stop();
    await buildResumeSpec(plugins, "claude", facts, ctx, "s-1", "manual");
    expect(heard).toBe(0);

    let after = 0;
    const again = subscribeSpawnSpecs(() => {
      after += 1;
    });
    // Reset drops listeners with the rest of the state: a subscriber that
    // outlived the cache would keep reacting to a later test's writes.
    resetPaneSpawnSpecs();
    dropPaneSpawnSpec("pane-1");
    expect(after).toBe(0);
    again();
  });

  it("resolves an MCP secret to its pane, and forgets it with the plan", async () => {
    // The plan cache IS the registry of live secrets: a pane that retires
    // drops its spec, so a lingering MCP child resolves to nobody instead of
    // to whoever inherited its reusable `pane-N` slot.
    await buildResumeSpec(plugins, "claude", facts, ctx, "s-1", "manual");
    const secret = peekPaneSpawnSpec("pane-1")?.mcpToken;

    expect(secret).toBeDefined();
    expect(paneIdByMcpToken(secret!)).toBe("pane-1");
    expect(paneIdByMcpToken("a-secret-nobody-holds")).toBeNull();

    dropPaneSpawnSpec("pane-1");
    expect(paneIdByMcpToken(secret!)).toBeNull();
  });
});
