/**
 * The harness the plan suites share: the states a build reads (installed
 * plugins, staged skills, MCP access), the fixtures a claude-shaped agent
 * needs, and a per-suite host that registers agents and builds panes the
 * way the orchestrator's reconcile does.
 *
 * Every plan suite imports THIS and drives its own `describe` through the
 * harness, so the two suites (the plan itself, and MCP through the plan)
 * cannot drift in how a pane is built.
 */
import { act } from "react";
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
import { buildLivePaneSpec, peekPaneSpawnSpec, type SpawnPluginAccess } from ".";
import type { McpAccess } from "./plan";
// Straight from the module: the barrel deliberately does not carry it.
import { resetPaneSpawnSpecs } from "./cache";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export const hostState = { installed: [] as unknown[] };

// Staged skills are a host fact the plan build ASKS for — the worktree manager
// resolves them (and owns which directories get armed), so here it is a thunk
// and tests pick what it answers.
export const skillsState = { views: null as SpawnSkillsInput | null };
export const stagedSkills = () => Promise.resolve(skillsState.views);

// MCP access is asked for the same way, and answers with BOTH halves: the
// servers a hook puts on argv, and the on-disk delivery for a CLI that takes
// none. `delivered` records when that write actually happened, which is the
// whole point of it being separate from the answer.
export const mcpState = {
  entries: [] as McpAccess["entries"],
  throughArgv: true,
  delivered: [] as string[],
};
/** A local server with nothing to carry, and a remote one carrying its token. */
export const local = (
  name: string,
  command: string,
  args: string[] = [],
): McpAccess["entries"][number] => ({
  spec: { name, transport: "stdio", command, args },
  env: [],
});
export const GH_TOKEN: [string, string] = ["GH_TOKEN", "ghp_secret"];
export const github: McpAccess["entries"][number] = {
  spec: { name: "github", transport: "http", url: "https://mcp.example/", bearerTokenEnv: "GH_TOKEN" },
  env: [GH_TOKEN],
};
export const specsOf = (entries: McpAccess["entries"]) => entries.map(({ spec }) => spec);
export const mcpAccess = (target: { paneId?: string; cwd: string }) =>
  Promise.resolve({
    entries: mcpState.entries,
    throughArgv: mcpState.throughArgv,
    deliver: async () => {
      mcpState.delivered.push(target.cwd);
    },
  } satisfies McpAccess);

const pluginRegistries = createContributionRegistries();
export const plugins = {
  pluginRegistries,
  pluginHost: { getInstalled: () => hostState.installed },
} as unknown as SpawnPluginAccess;
export const runtime = { plugins } as unknown as AppRuntime;

/** A live bridge: the run root, plus the per-pane inbox the host creates
 * before each spawn. The pane's OWN directory is what reaches the agent. */
export const ctx = {
  ...EMPTY_SPAWN_CONTEXT,
  bridgeDir: "/bridge/run-1",
  bridgeUrl: "http://127.0.0.1:51611/envelope",
  paneBridgeDir: (paneId: string) => Promise.resolve(`/bridge/run-1/${paneId}`),
};
export const W1: WorkspaceRef = { id: "ws-1", instance: "workspace-instance-1" };

/** A claude-shaped agent: reporter args on spawn, --resume on resume. */
export const adopting: AgentContribution = {
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

export const ws = (panes: Workspace["panes"], teams?: Workspace["teams"]): Workspace[] => [
  {
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "ws",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes,
    ...(teams && { teams }),
  },
];

/** Let the build→cache→tick chain settle. */
export const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};

/** One suite's host: registers agents for its tests, builds panes, and
 * collects what landed in the cache. `reset` before each test, `teardown`
 * after. */
export function planHarness() {
  let registered: Disposable[] = [];
  const harness = {
    /** What landed in the cache at the last `mount`, by pane id. */
    seen: {} as Record<string, SpawnPlan>,
    register(agent: AgentContribution) {
      registered.push(pluginRegistries.agents.add("test-plugin", agent));
    },
    /** Drop every agent this suite registered — a test that swaps the
     * agent mid-way calls it before registering the next. */
    disposeAgents() {
      for (const d of registered) d.dispose();
      registered = [];
    },
    /** Build every live pane's plan, the way the orchestrator's reconcile
     * does, and collect what landed in the cache. No render: deciding what
     * a pane runs stopped needing one. */
    async mount(workspaces: Workspace[], context: typeof ctx = ctx) {
      for (const workspace of workspaces) {
        for (const pane of workspace.panes) {
          await buildLivePaneSpec(runtime.plugins, workspace, pane, context, {
            stagedSkills,
            mcpAccess,
          });
        }
      }
      harness.seen = {};
      for (const workspace of workspaces) {
        for (const pane of workspace.panes) {
          const spec = peekPaneSpawnSpec(pane.id);
          if (spec) harness.seen[pane.id] = spec;
        }
      }
    },
    reset() {
      resetPaneSpawnSpecs();
      hostState.installed = [];
      skillsState.views = null;
      mcpState.entries = [];
      mcpState.throughArgv = true;
      mcpState.delivered = [];
      harness.seen = {};
    },
    teardown() {
      harness.disposeAgents();
    },
  };
  return harness;
}
