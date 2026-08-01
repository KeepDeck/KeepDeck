// @vitest-environment happy-dom
import { emptyJournal as emptyJournalImpl } from "../../domain/journal";
import { act, useState } from "react";
import { vi } from "vitest";
import type {
  DeckState,
  Pane,
  PaneIdle,
  SpawnConfig,
  WorktreeTarget,
} from "../../domain/deck";
import { MAX_PANES as MAX_PANES_IMPL } from "../../domain/deck";
import type { WorkspaceCreationResult } from "../deckActions";
import type { SetupStep } from "../provisioning";
import type { SuspendOutcome } from "../suspendOutcome";
import { EMPTY_SPAWN_CONTEXT } from "../../domain/agents";
import { createWorkspaceInstance as createWorkspaceInstanceImpl } from "../../domain/workspaceInstance";
import type { SessionHandle } from "../../domain/journal";
import {
  buildForkSpec as buildForkSpecImpl,
  buildResumeSpec as buildResumeSpecImpl,
  clearPanePlanError as clearPanePlanErrorImpl,
  dropPaneSpawnSpec as dropPaneSpawnSpecImpl,
  peekPaneSpawnSpec as peekPaneSpawnSpecImpl,
  resetPaneSpawnSpecs as resetPaneSpawnSpecsImpl,
} from "../spawnSpecs";
import type { Deck } from "../useDeck";
import { useDeck } from "../useDeck";
import { createDeckStore } from "../deckStore";
import {
  createAgentOrchestrator,
  type AgentOrchestrator,
  type AgentRunView,
  type RestartOutcome,
  type ResumeRequest,
} from ".";
import { useAgentRunView } from "../useAgentRunView";
import type { SpawnPluginAccess } from "../spawnSpecs";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ipc = vi.hoisted(() => ({
  probeWorktree: vi.fn(),
}));

// Resume plans are built through the agent plugins' hooks; the seam is
// mocked with a tiny cache so these tests assert revive POLICY (when a
// resume plan is requested) — the plan CONTENT is the plugin tests' job.
/** A gate a test can hold the build open on, WITHOUT replacing the
 * implementation — a replaced one caches no plan, and the re-stamp under test
 * needs a plan to re-stamp. */
const gate = vi.hoisted(() => ({ build: null as Promise<void> | null }));

/** The plan cache behind the mock, reachable so a test can stand in a plan the
 * deck restored but never built here (a rejected boot resume). */
const plans = vi.hoisted(() => ({
  specs: new Map<string, unknown>(),
  /** Panes whose last plan build failed — the error tile's source. */
  failed: new Set<string>(),
  /** Set by the mock factory; a test that seeds the cache by hand calls it. */
  notify: (() => {}) as () => void,
}));

vi.mock("../spawnSpecs", () => {
  const { specs } = plans;
  // The cache tells its readers when a plan lands. Faked with the same
  // contract as the real one: every write notifies.
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  plans.notify = notify;
  return {
    subscribeSpawnSpecs: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // What the ordinary plan sweep does, in miniature: an unmarked pane with
    // no plan gets one. Faithful enough for the question these tests ask —
    // whether a pane that should run is started — and the build itself is
    // covered in spawnSpecs.test.ts.
    buildLivePaneSpec: vi.fn(
      async (_plugins: unknown, _ws: unknown, pane: { id: string; idle?: unknown }) => {
        if (pane.idle || specs.has(pane.id)) return false;
        specs.set(pane.id, { command: "claude", args: [], env: [] });
        notify();
        return true;
      },
    ),
    // Real state, not a hardcoded `false`: the published `planFailed` set is
    // what turns a pane into the error tile with its retry, and with no way to
    // put a pane INTO that state nothing about the tile could be tested.
    peekPanePlanError: (id: string) => plans.failed.has(id),
    clearPanePlanError: vi.fn((id: string) => {
      plans.failed.delete(id);
      notify();
    }),
    // The real predicate's shape: a RESTORE resume whose process died without
    // ever posting back. A manual one is ineligible by design.
    resumeDiedSilently: (
      spec: { resumeOf?: string; resumeOrigin?: string; postbackMark?: number } | undefined,
      count: number,
    ) =>
      spec?.resumeOrigin === "restore" &&
      !!spec.resumeOf &&
      spec.postbackMark === count,
    buildResumeSpec: vi.fn(
      async (
        _plugins: unknown,
        _agentType: string,
        facts: { paneId: string },
        _ctx: unknown,
        resumeId: string,
        origin: "restore" | "manual",
      ) => {
        if (gate.build) await gate.build;
        specs.set(facts.paneId, {
          args: ["--resume", resumeId],
          env: [],
          resumeOf: resumeId,
          resumeOrigin: origin,
          postbackMark: 0,
        });
        notify();
        return true;
      },
    ),
    // The plugin's store surgery, in miniature: it caches a plan for the pane
    // and says whether it could. What the surgery DOES is the plugin's test.
    buildForkSpec: vi.fn(async (_p: unknown, _a: string, facts: { paneId: string }) => {
      specs.set(facts.paneId, { args: [], env: [] });
      notify();
      return true;
    }),
    peekPaneSpawnSpec: (id: string) =>
      specs.get(id) as
        | {
            args: string[];
            resumeOf?: string;
            resumeOrigin?: string;
            postbackMark?: number;
          }
        | undefined,
    // A refused manual wake drops the half-built plan, or the pane's next
    // wake lands on the plan-error tile instead of a terminal.
    dropPaneSpawnSpec: vi.fn((id: string) => {
      const had = specs.delete(id);
      notify();
      return had;
    }),
    markPaneResumeOrigin: vi.fn((id: string, origin: string) => {
      const spec = specs.get(id) as Record<string, unknown> | undefined;
      if (spec) specs.set(id, { ...spec, resumeOrigin: origin });
      notify();
    }),
    resetPaneSpawnSpecs: () => {
      specs.clear();
      plans.failed.clear();
      // The orchestrator under test subscribes on construction; a listener
      // from a previous mount would keep reconciling its own dead deck.
      listeners.clear();
    },
  };
});
/** The fake worktree manager records post-provision steps for fork tests. */
const steps = vi.hoisted(() => ({
  register: vi.fn(),
  clear: vi.fn(),
}));
/** Record the deferred staged-skill question carried by spawn facts. */
const skillsAsked = vi.fn(
  (_workspace: { id: string; instance: string }, _landing?: string) =>
    Promise.resolve(null),
);
vi.mock("../postbacks", () => ({ postbackCount: () => 0 }));

/** A retired session's telemetry must not stay bound to the pane, or a
 *  suspended card keeps showing the dead conversation's ctx% and cost and a
 *  restarted pane accumulates on top of the old baseline. Five call sites,
 *  previously none of them asserted. */
const usage = vi.hoisted(() => ({ clearPaneUsage: vi.fn() }));
vi.mock("../usageManager", () => usage);

/** What each pane's create has put on disk, as `provisioning` publishes it the
 *  moment `git worktree add` returns. */
const published = vi.hoisted(
  () =>
    new Map<string, Promise<{ repo: string; path: string; branch: string } | null>>(),
);

export const ipcHarness = ipc;
export const gateHarness = gate;
export const plansHarness = plans;
export const stepsHarness = steps;
export const usageHarness = usage;
export const publishedHarness = published;
export const skillsAskedHarness = skillsAsked;
export {
  gateHarness as gate,
  ipcHarness as ipc,
  plansHarness as plans,
  publishedHarness as published,
  stepsHarness as steps,
  skillsAskedHarness as skillsAsked,
  usageHarness as usage,
};
export const buildForkSpec = buildForkSpecImpl;
export const buildResumeSpec = buildResumeSpecImpl;
export const clearPanePlanError = clearPanePlanErrorImpl;
export const dropPaneSpawnSpec = dropPaneSpawnSpecImpl;
export const peekPaneSpawnSpec = peekPaneSpawnSpecImpl;
export const resetPaneSpawnSpecs = resetPaneSpawnSpecsImpl;
export const MAX_PANES = MAX_PANES_IMPL;
export const createWorkspaceInstance = createWorkspaceInstanceImpl;
export const emptyJournal = emptyJournalImpl;

/** The session registry as the orchestrator sees it: what it started, and
 *  what each pane's process is doing. */
export const pty = {
  /** The WHOLE spec, args and env included. Recording only the pane id left
   *  the step the orchestrator absorbed from TerminalPane unguarded: nothing
   *  proved a resume plan's `--resume <id>` reached the spawned process. */
  acquired: [] as {
    paneId: string;
    command?: string | null;
    cwd?: string | null;
    args?: string[];
    env?: [string, string][];
  }[],
  live: new Set<string>(),
  acquire(
    paneId: string,
    spec: {
      command?: string | null;
      cwd?: string | null;
      args?: string[];
      env?: [string, string][];
    },
  ) {
    pty.acquired.push({
      paneId,
      command: spec.command,
      cwd: spec.cwd,
      args: spec.args,
      env: spec.env,
    });
    pty.live.add(paneId);
    pty.notify();
  },
  closed: [] as string[],
  /** Reaping is not instant: a test may hold it open to see what the deck
   *  looks like while a process is still going down. */
  hold: null as Promise<void> | null,
  close(paneId: string) {
    pty.closed.push(paneId);
    pty.live.delete(paneId);
    // The real registry drops the entry and fires its listeners SYNCHRONOUSLY,
    // before the teardown IPC settles. A no-op stub here made the sweep that
    // this notification drives invisible to every test in the file — which is
    // exactly where a restart racing that sweep would have shown up.
    pty.notify();
    return pty.hold ?? Promise.resolve();
  },
  listeners: new Set<() => void>(),
  subscribe(listener: () => void) {
    pty.listeners.add(listener);
    return () => pty.listeners.delete(listener);
  },
  notify() {
    for (const listener of [...pty.listeners]) listener();
  },
  /** One-off commands run in a pane's slot — the workspace setup step. */
  ranOnce: [] as { paneId: string; args: string[] | undefined }[],
  runOnce(paneId: string, spec: { args?: string[] }) {
    pty.ranOnce.push({ paneId, args: spec.args });
    return Promise.resolve({ ok: true, tail: "" });
  },
  state: (paneId: string) =>
    pty.live.has(paneId)
      ? ({ kind: "live" } as const)
      : ({ kind: "none" } as const),
  reset() {
    pty.acquired = [];
    pty.live.clear();
    pty.closed = [];
    pty.ranOnce = [];
    pty.hold = null;
    // Listeners go with the rest: an orchestrator from a previous mount would
    // otherwise keep reconciling its own dead deck on every state change.
    pty.listeners.clear();
  },
};

export let deck: Deck;
export let agentRun: AgentRunView &
  Pick<
    AgentOrchestrator,
    | "resume"
    | "startFresh"
    | "createPane"
    | "createWorkspace"
    | "retryProvisioning"
    | "resumeSession"
    | "forkSession"
    | "suspend"
    | "restart"
    | "recoverRejectedResume"
    | "retryPlanBuild"
    | "close"
  >;
/** The worktree creates the orchestrator asked for, recorded instead of run.
 *  Per mount like the deck beside it, so no `describe` has to remember to
 *  clear it. */
export let provisions: { panes: Pane[]; setup: SetupStep | undefined }[];
/** The worktree removals a confirmed close asked for, per mount. */
export let discards: WorktreeTarget[][];
/** What the removal reports back as un-deletable. */
let discardFailures: string[] = [];
export const setDiscardFailures = (failures: string[]) => {
  discardFailures = failures;
};
export const ctx = { ...EMPTY_SPAWN_CONTEXT, bridgeDir: "/bridge/run-1" };

// What the orchestrator's gate consults — swappable per test. The id set is
// open (a pane whose agent no plugin provides must be skipped), and the launch
// policy is read live, so a test may flip it while the deck stands.
export const catalog = {
  parkOnLaunch: false,
  moveSuspendedToTray: false,
  agents: ["claude", "codex", "opencode"].map((id) => ({
    id,
    label: id,
    command: id,
    features: [],
    installed: true,
    path: null,
  })),
  ready: true,
};

/** One store + one orchestrator per mount, wired to the swappable fakes above
 *  — the isolation each test relies on, without a `beforeEach` in every
 *  `describe` having to remember it. The orchestrator itself needs no render;
 *  the component is only here because these tests also exercise the view it
 *  publishes. */
export function Probe() {
  const [wiring] = useState(() => {
    const store = createDeckStore();
    const asked: { panes: Pane[]; setup: SetupStep | undefined }[] = [];
    const discarded: WorktreeTarget[][] = [];
    return {
      store,
      asked,
      discarded,
      orchestrator: createAgentOrchestrator({
        deck: store,
        spawnContext: { get: () => ctx, subscribe: () => () => {} },
        agents: {
          commands: () =>
            new Map(catalog.agents.map((a) => [a.id, a.command])),
          // A catalog that is not ready never resolves: waking anything before
          // the plugin system has booted would misjudge every pane's agent.
          ready: () =>
            catalog.ready ? Promise.resolve() : new Promise<void>(() => {}),
          subscribe: () => () => {},
        },
        launchPolicy: {
          parkOnLaunch: () => catalog.parkOnLaunch,
          subscribe: () => () => {},
        },
        suspendPolicy: {
          moveToTray: () => catalog.moveSuspendedToTray,
        },
        sessions: {
          subscribe: pty.subscribe,
          state: (paneId: string) => pty.state(paneId),
          acquire: pty.acquire,
          close: pty.close,
          runOnce: pty.runOnce,
        },
        plugins: {} as SpawnPluginAccess,
        probe: ipc.probeWorktree,
        mcpDefs: async () => [],
    worktrees: {
          provision: (panes, _report, setup) => {
            asked.push({ panes, setup });
            return Promise.resolve();
          },
          awaitCreated: (paneId) => {
            const made = published.get(paneId);
            if (!made) return Promise.resolve(null);
            published.delete(paneId);
            return made;
          },
          registerPostProvision: steps.register,
          clearPostProvision: steps.clear,
          skillsFor: skillsAsked,
          remove: (targets) => {
            discarded.push(targets);
            return Promise.resolve(discardFailures);
          },
        },
      }),
    };
  });
  deck = useDeck(wiring.store);
  provisions = wiring.asked;
  discards = wiring.discarded;
  agentRun = {
    ...useAgentRunView(wiring.orchestrator),
    resume: wiring.orchestrator.resume,
    startFresh: wiring.orchestrator.startFresh,
    createPane: wiring.orchestrator.createPane,
    createWorkspace: wiring.orchestrator.createWorkspace,
    retryProvisioning: wiring.orchestrator.retryProvisioning,
    resumeSession: wiring.orchestrator.resumeSession,
    forkSession: wiring.orchestrator.forkSession,
    suspend: wiring.orchestrator.suspend,
    restart: wiring.orchestrator.restart,
    recoverRejectedResume: wiring.orchestrator.recoverRejectedResume,
    retryPlanBuild: wiring.orchestrator.retryPlanBuild,
    close: wiring.orchestrator.close,
  };
  return null;
}

/** A deck with one idle (restored) claude pane; `pane` overrides fields. */
export const restored = (pane: object): DeckState => ({
  workspaces: [
    {
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        { id: "pane-1", agentType: "claude", idle: { reason: "waking", origin: "restore" }, ...pane },
      ],
    },
  ],
  activeId: "ws-1",
  journal: emptyJournal,
  viewByWs: {},
});

/** Let the probe→validate→revive promise chain settle. */
export const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};


export type {
  DeckState,
  Pane,
  PaneIdle,
  SessionHandle,
  SetupStep,
  SpawnConfig,
  SpawnPluginAccess,
  SuspendOutcome,
  WorkspaceCreationResult,
  RestartOutcome,
  ResumeRequest,
};
