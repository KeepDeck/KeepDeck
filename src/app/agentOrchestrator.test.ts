// @vitest-environment happy-dom
import { emptyJournal } from "../domain/journal";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DeckState,
  Pane,
  PaneIdle,
  SpawnConfig,
  WorktreeTarget,
} from "../domain/deck";
import { MAX_PANES } from "../domain/deck";
import type { WorkspaceCreationResult } from "./deckActions";
import type { SetupStep } from "./provisioning";
import type { SuspendOutcome } from "./suspendOutcome";
import { EMPTY_SPAWN_CONTEXT } from "../domain/agents";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { SessionHandle } from "../domain/journal";
import {
  buildForkSpec,
  buildResumeSpec,
  clearPanePlanError,
  dropPaneSpawnSpec,
  peekPaneSpawnSpec,
  resetPaneSpawnSpecs,
} from "./spawnSpecs";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { createDeckStore } from "./deckStore";
import {
  createAgentOrchestrator,
  type AgentOrchestrator,
  type AgentRunView,
  type RestartOutcome,
  type ResumeRequest,
} from "./agentOrchestrator";
import { useAgentRunView } from "./useAgentRunView";
import type { SpawnPluginAccess } from "./spawnSpecs";

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

vi.mock("./spawnSpecs", () => {
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
/** The post-provision map is write-only by design (a step is consumed when it
 *  succeeds), so a fork test has no way to read back the step it registered.
 *  Spied and delegated: the real behaviour stands, and the step is reachable. */
const steps = vi.hoisted(() => ({
  register: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("./postbacks", () => ({ postbackCount: () => 0 }));

/** A retired session's telemetry must not stay bound to the pane, or a
 *  suspended card keeps showing the dead conversation's ctx% and cost and a
 *  restarted pane accumulates on top of the old baseline. Five call sites,
 *  previously none of them asserted. */
const usage = vi.hoisted(() => ({ clearPaneUsage: vi.fn() }));
vi.mock("./usageManager", () => usage);

/** What each pane's create has put on disk, as `provisioning` publishes it the
 *  moment `git worktree add` returns. */
const published = vi.hoisted(
  () =>
    new Map<string, Promise<{ repo: string; path: string; branch: string } | null>>(),
);

vi.mock("./provisioning", async (importOriginal) => {
  const real = await importOriginal<typeof import("./provisioning")>();
  return {
    ...real,
    takeCreatedWorktree: (paneId: string) => {
      const made = published.get(paneId);
      if (!made) return Promise.resolve(null);
      published.delete(paneId);
      return made;
    },
    registerPostProvision: (
      paneId: string,
      step: (worktree: { cwd: string; branch: string }) => Promise<void>,
    ) => {
      steps.register(paneId, step);
      real.registerPostProvision(paneId, step);
    },
    clearPostProvision: (paneId: string) => {
      steps.clear(paneId);
      real.clearPostProvision(paneId);
    },
  };
});

/** The session registry as the orchestrator sees it: what it started, and
 *  what each pane's process is doing. */
const pty = {
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

let deck: Deck;
let agentRun: AgentRunView &
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
let provisions: { panes: Pane[]; setup: SetupStep | undefined }[];
/** The worktree removals a confirmed close asked for, per mount. */
let discards: WorktreeTarget[][];
/** What the removal reports back as un-deletable. */
let discardFailures: string[] = [];
const ctx = { ...EMPTY_SPAWN_CONTEXT, bridgeDir: "/bridge/run-1" };

// What the orchestrator's gate consults — swappable per test. The id set is
// open (a pane whose agent no plugin provides must be skipped), and the launch
// policy is read live, so a test may flip it while the deck stands.
const catalog = {
  parkOnLaunch: false,
  agents: ["claude", "codex", "opencode"].map((id) => ({
    id,
    label: id,
    command: id,
    supportsYolo: false,
    installed: true,
    path: null,
    usageCapabilities: ["paneTelemetry", "accountLimits"] as const,
  })),
  ready: true,
};

/** One store + one orchestrator per mount, wired to the swappable fakes above
 *  — the isolation each test relies on, without a `beforeEach` in every
 *  `describe` having to remember it. The orchestrator itself needs no render;
 *  the component is only here because these tests also exercise the view it
 *  publishes. */
function Probe() {
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
        sessions: {
          subscribe: pty.subscribe,
          state: (paneId: string) => pty.state(paneId),
          acquire: pty.acquire,
          close: pty.close,
          runOnce: pty.runOnce,
        },
        plugins: {} as SpawnPluginAccess,
        probe: ipc.probeWorktree,
        provision: (panes, _report, setup) => {
          asked.push({ panes, setup });
          return Promise.resolve();
        },
        discardWorktrees: (targets) => {
          discarded.push(targets);
          return Promise.resolve(discardFailures);
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
const restored = (pane: object): DeckState => ({
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
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};

describe("agent orchestrator —session policy", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const pane = () => deck.workspaces[0].panes[0];

  it("publishes the resumed pane's plan, not just the process", async () => {
    // The plan reaching the cache is not the point — the DECK reads the
    // published view to decide whether to mount a terminal at all. A resume
    // filled the cache directly, so the ordinary plan sweep short-circuited
    // and nothing ever republished: the agent ran behind a permanent
    // "Waking up…" card, with no terminal attached to hear it exit.
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await settle();

    expect(pty.acquired.map((a) => a.paneId)).toEqual(["pane-1"]);
    expect(agentRun.specs["pane-1"]).toBeDefined();
  });

  it("spawns the resume plan's OWN argv, not a bare fresh agent", async () => {
    // The orchestrator took this step over from the terminal, so the pane's
    // plan and the process it starts are now one owner's business. A spawn
    // that dropped the args would start a DIFFERENT conversation and let its
    // reporter overwrite the binding — the substitution the manual origin
    // exists to prevent, invisible to every assertion on the cache.
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await settle();

    expect(pty.acquired[0]).toMatchObject({
      paneId: "pane-1",
      args: ["--resume", "s-1"],
      cwd: "/repo",
    });
  });

  it("a recorded binding is TRUSTED and resumed — no store is read", async () => {
    // The binding came from the pane's own process (the reporter posts at
    // session creation), so it existed; a session deleted since fails the
    // resume VISIBLY in the terminal — accepted, rare, uniform. The app
    // never opens an agent's session store.
    act(() => deck.hydrate(restored({ session: { id: "old", boundAt: "t" } })));
    await settle();

    expect(pane().idle).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual(["--resume", "old"]);
    expect(pane().session).toEqual({ id: "old", boundAt: "t" }); // kept
    expect(vi.mocked(buildResumeSpec)).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      {
        paneId: "pane-1",
        workspace: {
          id: "ws-1",
          instance: deck.workspaces[0].instance,
        },
        cwd: "/repo",
        branch: undefined,
        yolo: undefined,
        wsSkillRoots: ["/repo"],
      },
      expect.anything(),
      "old",
      "restore",
    );
  });

  it("an unbound pane starts FRESH — never matched by directory", async () => {
    // Every agent reports its id post-hoc now, so an unbound pane is normal
    // (never messaged, a mid-TUI /new, or a reporter that couldn't arm).
    // Matching the newest session in the pane's cwd would resume a FOREIGN
    // conversation whenever panes share a cwd (the default — a worktree is
    // optional): unbound wakes fresh, with no resume spec.
    act(() => deck.hydrate(restored({ agentType: "codex", cwd: "/repo" })));
    await settle();

    expect(pane().idle).toBeUndefined();
    // It came up on the ordinary plan: nothing to resume in its args.
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual([]);
  });

  it("a REMOTE pane wakes fresh — no directory probe, no resume", async () => {
    // A remote pane runs against a VPS endpoint: it has no local dir to probe
    // (so a gone workspace cwd never blocks it) and is fresh-session only, so
    // even a stale `session` is ignored — never handed to the resume path
    // (which would spawn locally and drop the endpoint).
    ipc.probeWorktree.mockClear();
    // Reset, not clear: `mockClear` leaves an unconsumed `…Once` queue in
    // place, which then answers the FIRST build of the next test.
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    act(() =>
      deck.hydrate(
        restored({
          agentType: "codex",
          remoteEndpoint: "ws://vps:4500",
          session: { id: "stale", boundAt: "t" },
        }),
      ),
    );
    await settle();

    expect(pane().idle).toBeUndefined(); // woken
    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled(); // fresh
    expect(ipc.probeWorktree).not.toHaveBeenCalled(); // no local dir to probe
  });

  it("an agent no plugin provides stays idle — and KEEPS its binding", async () => {
    // Waking would spawn the bare id as a command; the binding may resume
    // perfectly once the plugin is re-enabled. No wake, no probe.
    act(() =>
      deck.hydrate(
        restored({ agentType: "gemini", session: { id: "old", boundAt: "t" } }),
      ),
    );
    await settle();

    expect(pane().idle).toEqual({ reason: "waking", origin: "restore" });
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
    expect(pane().session).toEqual({ id: "old", boundAt: "t" });
  });

  it("nothing wakes before the catalog is ready", async () => {
    // Before plugin bootstrap EVERY id is absent from the catalog — waking
    // then would misjudge every pane. The orchestrator waits for the boot.
    //
    // Rebuilt rather than re-rendered: readiness is a fact about THIS boot and
    // never goes back, so the orchestrator captures it once. Re-rendering the
    // same tree would keep the ready one this describe's setup started.
    catalog.ready = false;
    act(() => root.unmount());
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
    act(() => deck.hydrate(restored({})));
    await settle();

    expect(pane().idle).toEqual({ reason: "waking", origin: "restore" });
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });

  it("a gone directory blocks revival instead of spawning into nowhere", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(restored({ cwd: "/repo/wt-gone" })));
    await settle();

    expect(pane().idle).toEqual({ reason: "waking", origin: "restore" });
    expect(agentRun.blocked["pane-1"]).toBe("/repo/wt-gone");
  });

  it("closing a blocked pane reaps its blocked entry", async () => {
    // Pane ids are never reused, so entries left behind by closed panes
    // would accumulate for the whole session.
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(restored({ cwd: "/repo/wt-gone" })));
    await settle();
    expect(agentRun.blocked["pane-1"]).toBe("/repo/wt-gone");

    act(() => deck.closeAgent("ws-1", "pane-1"));
    await settle();
    expect(agentRun.blocked).toEqual({});
  });
});

describe("agent orchestrator —resuming a suspended pane", () => {
  let root: Root;

  /** A deck with one bound pane on a worktree, suspended unless overridden —
   * some cases need the same pane in a different idle state. */
  const withPane = (pane: object = {}): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-1",
            agentType: "claude",
            cwd: "/repo/wt-1",
            branch: "kd/ws/1",
            session: { id: "s-1", boundAt: "t" },
            idle: { reason: "suspended", at: "2026-07-25T09:00:00.000Z" },
            ...pane,
          },
        ],
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const pane = () => deck.workspaces[0].panes[0];

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("stays put until asked — the sweep never wakes it on its own", async () => {
    act(() => deck.hydrate(withPane()));
    await settle();

    expect(pane().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T09:00:00.000Z",
    });
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });

  it("resumes into its worktree with its recorded session", async () => {
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    expect(pane().idle).toBeUndefined(); // live: the terminal mounts
    expect(ipc.probeWorktree).toHaveBeenCalledWith("/repo/wt-1");
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual(["--resume", "s-1"]);
  });

  it("builds the resume plan as MANUAL — a rejected id must not silently start a new conversation", async () => {
    // The boot restore path stamps "restore", which arms a one-shot fallback:
    // if the CLI refuses the recorded id and dies without reporting, the pane
    // respawns fresh AND its binding is wiped, with no notification. That is
    // right for a launch nobody is watching and wrong for a button the user
    // pressed after being promised this session by name.
    // Reset, not clear: `mockClear` leaves an unconsumed `…Once` queue in
    // place, which then answers the FIRST build of the next test.
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    expect(vi.mocked(buildResumeSpec)).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      expect.anything(),
      expect.anything(),
      "s-1",
      "manual",
    );
  });

  it("a resume whose plan cannot be BUILT stays stopped instead of starting a new conversation", async () => {
    // The second door onto the same failure: the CLI never even runs. A
    // plugin with no resume.plan hook returns false without throwing, and
    // waking anyway would let the fresh sweep spawn a NEW conversation whose
    // reporter then overwrites the binding the card promised by name.
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    // Back down where it was, with its stamp and its binding intact…
    expect(pane().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T09:00:00.000Z",
    });
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined();
    // …and the card can say why.
    expect(agentRun.wakeFailed["pane-1"]).toContain("resume plan");
  });

  it("a BOOT restore whose plan cannot be built still degrades to a fresh wake", async () => {
    // The documented trade the manual path deliberately does not take:
    // nobody is watching a launch, and an empty pane beats a dead one.
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);
    act(() =>
      deck.hydrate(withPane({ idle: { reason: "waking", origin: "restore" } })),
    );
    await settle();

    expect(pane().idle).toBeUndefined(); // woken
    expect(agentRun.wakeFailed["pane-1"]).toBeUndefined();
  });

  it("a resume whose resume.plan THROWS is treated the same way", async () => {
    vi.mocked(buildResumeSpec).mockRejectedValueOnce(new Error("hook exploded"));
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    expect(pane().idle).toMatchObject({ reason: "suspended" });
    expect(agentRun.wakeFailed["pane-1"]).toContain("hook exploded");
  });

  it("asking again clears the last refusal", async () => {
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);
    act(() => deck.hydrate(withPane()));
    await settle();
    act(() => agentRun.resume("ws-1", "pane-1"));
    await settle();
    expect(agentRun.wakeFailed["pane-1"]).toBeDefined();

    // The gesture that asks also forgets — a card must not keep explaining a
    // failure the user is already retrying.
    act(() => agentRun.resume("ws-1", "pane-1"));
    await settle();

    expect(agentRun.wakeFailed["pane-1"]).toBeUndefined();
    expect(pane().idle).toBeUndefined(); // the retry succeeded
  });

  it("a pane RESTORED at launch still builds as restore — only a click is manual", async () => {
    // The distinction lives on the pane's own marker, so the sweep cannot
    // guess wrong: a pane hydration woke keeps the boot semantics.
    // Reset, not clear: `mockClear` leaves an unconsumed `…Once` queue in
    // place, which then answers the FIRST build of the next test.
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    act(() =>
      deck.hydrate(withPane({ idle: { reason: "waking", origin: "restore" } })),
    );
    await settle();

    expect(vi.mocked(buildResumeSpec)).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      expect.anything(),
      expect.anything(),
      "s-1",
      "restore",
    );
  });

  it("a DELETED worktree blocks the resume instead of spawning into nowhere", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    // No process, no resume plan: the pane goes back DOWN where it came from,
    // stamp intact, and reports the missing directory so its card can explain
    // itself. Leaving it `waking` would strand it — that state is never
    // persisted, so a restart would lose the suspend entirely.
    expect(pane().idle).toEqual({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" });
    expect(agentRun.blocked["pane-1"]).toBe("/repo/wt-1");
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined();
    // The binding survives — nothing has decided to abandon that session yet.
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
  });

  it("blocked once, probed once — a wedged pane never loops on the sweep", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(withPane()));
    await settle();
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();
    await settle();

    expect(ipc.probeWorktree).toHaveBeenCalledTimes(1);
  });

  it("start-fresh relocates it to the workspace folder — and DROPS the session", async () => {
    // The worktree is gone; the workspace folder it relocates INTO is not.
    ipc.probeWorktree.mockImplementation((dir: string) =>
      Promise.resolve({
        exists: dir === "/repo",
        isWorktree: false,
        empty: false,
        branch: null,
      }),
    );
    act(() => deck.hydrate(withPane()));
    await settle();
    act(() => agentRun.resume("ws-1", "pane-1"));
    await settle();

    act(() => agentRun.startFresh("ws-1", "pane-1"));
    await settle();

    expect(agentRun.blocked).toEqual({});
    expect(pane().idle).toBeUndefined();
    // The worktree is gone, so the conversation recorded against it cannot be
    // resumed here: cwd, branch and binding all go, and the pane starts new.
    expect(pane().cwd).toBeUndefined();
    expect(pane().branch).toBeUndefined();
    expect(pane().session).toBeUndefined();
    // The ordinary plan, carrying nothing to resume.
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual([]);
  });
});

describe("agent orchestrator —waking across workspace switches", () => {
  let root: Root;

  /** Two workspaces, ws-1 active, one pane each with the given idle reason
   *  (or none, for panes that simply exist). */
  const twoWorkspaces = (idle?: PaneIdle): DeckState => ({
    workspaces: ["ws-1", "ws-2"].map((id) => ({
      id,
      instance: createWorkspaceInstance(),
      name: id,
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [{ id: `${id}-pane`, agentType: "claude", ...(idle && { idle }) }],
    })),
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const paneOf = (wsId: string) =>
    deck.workspaces.find((w) => w.id === wsId)!.panes[0];

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("starts the pane on screen and leaves the one nobody has opened alone", async () => {
    // The economy this whole gate exists for: a workspace that may never be
    // used costs nothing. Both panes are unmarked and both have plans — only
    // the visible one gets a process.
    act(() => deck.hydrate(twoWorkspaces(undefined)));
    await settle();

    expect(pty.acquired.map((a) => a.paneId)).toEqual(["ws-1-pane"]);
  });

  it("starts the second one when its workspace is opened, and only then", async () => {
    act(() => deck.hydrate(twoWorkspaces(undefined)));
    await settle();
    act(() => deck.selectWorkspace("ws-2"));
    await settle();

    expect(pty.acquired.map((a) => a.paneId)).toEqual(["ws-1-pane", "ws-2-pane"]);
  });

  it("does not start a second process for a pane that already has one", async () => {
    act(() => deck.hydrate(twoWorkspaces(undefined)));
    await settle();
    // Any notification re-runs the reconcile; the started pane must be left
    // exactly as it is.
    act(() => deck.renameWorkspace("ws-1", "renamed"));
    await settle();

    expect(pty.acquired).toHaveLength(1);
  });

  it("stops starting agents the moment the launch policy says so, and says they are stopped", async () => {
    // The bug this closes: the policy used to be applied once, to the deck as
    // it was hydrated. A pane waiting in an unopened workspace kept the marker
    // it was given at boot, so turning the setting on and then switching
    // workspaces started every agent in them anyway.
    act(() => deck.hydrate(twoWorkspaces({ reason: "waking", origin: "restore" })));
    await settle();
    expect(paneOf("ws-2").idle).toEqual({ reason: "waking", origin: "restore" });

    // ws-1's pane legitimately started with the deck; only what happens AFTER
    // the flip is the subject.
    ipc.probeWorktree.mockClear();
    catalog.parkOnLaunch = true;
    act(() => deck.selectWorkspace("ws-2"));
    await settle();

    expect(paneOf("ws-2").idle).toEqual({ reason: "parked" });
    // Not merely unstarted: nothing was even probed for it.
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });

  it("leaves the agent that is already running alone when the policy flips", async () => {
    // ws-1's pane started with the deck. A preference changing must not reach
    // back and kill a live agent.
    act(() => deck.hydrate(twoWorkspaces({ reason: "waking", origin: "restore" })));
    await settle();
    expect(paneOf("ws-1").idle).toBeUndefined();

    catalog.parkOnLaunch = true;
    act(() => deck.selectWorkspace("ws-2"));
    await settle();

    expect(paneOf("ws-1").idle).toBeUndefined();
  });

  it("still serves a resume the user asks for while the policy is on", async () => {
    catalog.parkOnLaunch = true;
    act(() => deck.hydrate(twoWorkspaces({ reason: "parked" })));
    await settle();
    expect(paneOf("ws-2").idle).toEqual({ reason: "parked" });

    expect(agentRun.resume("ws-2", "ws-2-pane")).toBe("resuming");
    await settle();

    expect(paneOf("ws-2").idle).toBeUndefined();
  });

  it("RESTORED panes wake lazily: the active workspace at launch, the other on its first activation", async () => {
    act(() => deck.hydrate(twoWorkspaces({ reason: "waking", origin: "restore" })));
    await settle();

    expect(paneOf("ws-1").idle).toBeUndefined(); // launched with the deck
    expect(paneOf("ws-2").idle).toEqual({ reason: "waking", origin: "restore" }); // still asleep

    act(() => deck.selectWorkspace("ws-2"));
    await settle();

    expect(paneOf("ws-2").idle).toBeUndefined(); // woken by the switch
  });

  it("PARKED panes stay stopped through a workspace switch, not just at launch", async () => {
    act(() => deck.hydrate(twoWorkspaces({ reason: "parked" })));
    await settle();

    act(() => deck.selectWorkspace("ws-2"));
    await settle();

    expect(paneOf("ws-1").idle).toEqual({ reason: "parked" });
    expect(paneOf("ws-2").idle).toEqual({ reason: "parked" });
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });
});

describe("agent orchestrator —a blocked pane can be re-probed", () => {
  let root: Root;

  const blockedDeck = (): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-1",
            agentType: "claude",
            cwd: "/repo/wt-1",
            session: { id: "s-1", boundAt: "t" },
            idle: { reason: "suspended", at: "2026-07-25T09:00:00.000Z" },
          },
        ],
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const pane = () => deck.workspaces[0].panes[0];

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset();
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("looks again when the folder comes back, keeping the session", async () => {
    // A blocked pane is skipped for the rest of the session, so without a
    // retry an unmounted volume left it stuck behind a card whose only other
    // exit throws the binding away.
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(blockedDeck()));
    await settle();
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();
    expect(agentRun.blocked["pane-1"]).toBe("/repo/wt-1");

    // The volume is back.
    ipc.probeWorktree.mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => agentRun.resume("ws-1", "pane-1"));
    await settle();

    expect(agentRun.blocked["pane-1"]).toBeUndefined();
    expect(pane().idle).toBeUndefined(); // live again
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual(["--resume", "s-1"]);
  });

  it("stays blocked, with its stamp, when the folder is still gone", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(blockedDeck()));
    await settle();
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    act(() => agentRun.resume("ws-1", "pane-1"));
    await settle();

    expect(agentRun.blocked["pane-1"]).toBe("/repo/wt-1");
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
  });
});

describe("agent orchestrator —a request that lands mid-flight", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    // Reset, not clear: `mockClear` leaves an unconsumed `…Once` queue in
    // place, which then answers the FIRST build of the next test.
    vi.mocked(buildResumeSpec).mockReset();
    // This block asserts CALL HISTORY on the drop; without a clear it would
    // be satisfied by an earlier describe's calls for the same pane id, and
    // the branch it targets could stop dropping without anything failing.
    vi.mocked(dropPaneSpawnSpec).mockClear();
    gate.build = null;
    ipc.probeWorktree.mockReset();
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const pane = () => deck.workspaces[0].panes[0];
  const origins = () =>
    vi.mocked(buildResumeSpec).mock.calls.map((call) => call[5]);

  /** A probe held open, so a gesture can land while the wake is in flight. */
  const heldProbe = () => {
    let release!: () => void;
    ipc.probeWorktree.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ exists: true, isWorktree: false, empty: false, branch: null });
        }),
    );
    return () => release();
  };

  it("serves a resume asked for DURING the probe as the user's, not as a boot restore", async () => {
    // The sweep holds the pane in its in-flight set, so the request starts no
    // second attempt — the one already running has to notice it. Judging by
    // the origin captured when the probe went out is how a resume the user
    // asked for by name came up as a fresh conversation instead.
    const release = heldProbe();
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    // The pane is mid-probe; ask for it by name (the `agent.resume` path).
    let asked: ResumeRequest | undefined;
    act(() => {
      asked = agentRun.resume("ws-1", "pane-1");
    });
    expect(asked).toBe("resuming");
    release();
    await settle();

    expect(origins()).toEqual(["manual"]);
    expect(pane().idle).toBeUndefined();
  });

  it("clears the failure flag when a BOOT restore's plan build throws", async () => {
    // The build that throws also marks the pane as plan-failed inside
    // spawnSpecs, so waking it without dropping that flag lands it on the
    // "Couldn't start this agent" tile — while the code here says a restore
    // that fails "wakes fresh". The manual branch drops the flag and says
    // why; the restore branch has to do the same or it doesn't wake fresh at
    // all, it wakes broken.
    ipc.probeWorktree.mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    vi.mocked(buildResumeSpec).mockRejectedValueOnce(new Error("hook blew up"));
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await settle();

    expect(pane().idle).toBeUndefined(); // woken, as documented
    expect(vi.mocked(dropPaneSpawnSpec)).toHaveBeenCalledWith("pane-1");
    // Nobody asked for this wake, so nothing is reported on the card.
    expect(agentRun.wakeFailed).toEqual({});
  });

  it("sees a request dispatched outside a React event", async () => {
    // `agent.resume` reached from MCP, the plugin bridge or a Tauri callback
    // dispatches from a promise continuation rather than a React event, so
    // the store holds the request before any render carries it. The sweep
    // reads the origin through the hook's deck, and this pins that the two
    // cannot come apart: if they ever did, the user's named resume would be
    // served as a boot restore — the one origin allowed to become a new
    // conversation. Deliberately NOT wrapped in act(): the un-flushed
    // dispatch is the point.
    const release = heldProbe();
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    deck.requestPaneWake("ws-1", "pane-1");
    release();
    await settle();

    expect(origins()).toEqual(["manual"]);
  });

  it("re-stamps a plan already built as a restore when the request arrives mid-BUILD", async () => {
    // The origin is baked into the cached plan — it is what arms the one-shot
    // fall back to a fresh conversation. A plan built as a restore therefore
    // cannot serve a resume the user asked for.
    // Held open, but still caching a plan the way a real build does — the
    // re-stamp has to have something to re-stamp.
    let releaseBuild!: () => void;
    gate.build = new Promise<void>((resolve) => (releaseBuild = resolve));
    ipc.probeWorktree.mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    act(() => {
      agentRun.resume("ws-1", "pane-1");
    });
    releaseBuild();
    await settle();

    // Built ONCE. The origin is a field of the assembled plan — it never
    // reaches the plugin's `resume.plan` hook — so re-running that hook to
    // change it would run a third party's code twice for something it cannot
    // see. The cached plan is re-stamped instead.
    expect(origins()).toEqual(["restore"]);
    expect(peekPaneSpawnSpec("pane-1")?.resumeOrigin).toBe("manual");
    expect(pane().idle).toBeUndefined();
  });

  it("drops the outcome of a wake the user CANCELLED mid-probe", async () => {
    // Suspending a rising pane cancels the wake. Building a plan for it
    // afterwards would hand a stopped pane a live resume spec, and reporting
    // the attempt would explain a failure nobody is waiting on.
    const release = heldProbe();
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    act(() => deck.suspendPane("ws-1", "pane-1"));
    release();
    await settle();

    expect(pane().idle).toMatchObject({ reason: "suspended" });
    expect(origins()).toEqual([]); // no plan built for a cancelled wake
    expect(agentRun.wakeFailed).toEqual({});
  });

  it("does not BLOCK a pane the user stopped while its folder was being probed", async () => {
    // The gone-folder verdict arrives without going through `wake` at all, so
    // it needs the same guard: marking the pane blocked would leave the
    // suspended card explaining a directory the user never asked about, and a
    // blocked pane is skipped by the sweep until something clears it.
    let release!: () => void;
    ipc.probeWorktree.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ exists: false, isWorktree: false, empty: false, branch: null });
        }),
    );
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    act(() => deck.suspendPane("ws-1", "pane-1"));
    release();
    await settle();

    expect(agentRun.blocked).toEqual({});
    expect(pane().idle).toMatchObject({ reason: "suspended" });
  });
});

describe("agent orchestrator —a pane asked for by name in another workspace", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    // Reset, not clear: `mockClear` leaves an unconsumed `…Once` queue in
    // place, which then answers the FIRST build of the next test.
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  /** Two workspaces, `ws-1` active; the pane to resume lives in `ws-2`. */
  const twoWorkspaces = (idle: PaneIdle): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "one",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1", agentType: "claude" }],
      },
      {
        id: "ws-2",
        instance: createWorkspaceInstance(),
        name: "two",
        cwd: "/other",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-2",
            agentType: "claude",
            idle,
            session: { id: "s-2", boundAt: "t" },
          },
        ],
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const background = () => deck.workspaces[1].panes[0];

  it("is served where it stands, instead of waiting for a workspace switch", async () => {
    // `agent.resume` takes a workspace argument precisely so it can reach a
    // pane that isn't on screen. Marking such a pane and then never sweeping
    // it left it neither running nor durably stopped: the suspend is dropped
    // from state (and from disk, it is the durable half) while nothing acts
    // on the request, so quitting before switching lost the suspend.
    act(() =>
      deck.hydrate(twoWorkspaces({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" })),
    );
    await settle();
    expect(background().idle).toMatchObject({ reason: "suspended" });

    act(() => {
      agentRun.resume("ws-2", "pane-2");
    });
    await settle();

    expect(background().idle).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-2")?.args).toEqual(["--resume", "s-2"]);
  });

  it("actually STARTS the off-screen pane it says it is resuming", async () => {
    // The whole point of the workspace argument. The wake cleared the pane's
    // durable `suspended` stamp and the next pass then judged it by the
    // unopened-workspace economy — which the request is exempt from — so the
    // pane was left neither running nor durably stopped. Quitting before
    // visiting ws-2 persisted it as a plain running pane, and the next launch
    // started the agent the user had parked.
    act(() =>
      deck.hydrate(twoWorkspaces({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" })),
    );
    await settle();
    pty.acquired = [];

    act(() => {
      agentRun.resume("ws-2", "pane-2");
    });
    await settle();

    expect(background().idle).toBeUndefined();
    expect(pty.acquired.map((a) => a.paneId)).toEqual(["pane-2"]);
    expect(agentRun.specs["pane-2"]).toBeDefined();
  });

  it("stops owing a start once the pane has a process", async () => {
    // The debt exempts a pane from the unopened-workspace economy. Left
    // behind, it would keep exempting that pane for the session — respawning
    // it on every exit in a workspace nobody has opened.
    act(() =>
      deck.hydrate(twoWorkspaces({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" })),
    );
    await settle();
    act(() => {
      agentRun.resume("ws-2", "pane-2");
    });
    await settle();
    expect(pty.acquired.map((a) => a.paneId)).toContain("pane-2");

    // Its process dies. Nothing asked for it again, so nothing restarts it.
    pty.acquired = [];
    act(() => {
      pty.live.delete("pane-2");
      pty.notify();
    });
    await settle();
    expect(pty.acquired).toEqual([]);
  });

  it("stops owing a start when the attempt gives up", async () => {
    // A refused wake is not a start still owed. Keeping the debt would exempt
    // the pane from the economy for the rest of the session.
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() =>
      deck.hydrate(twoWorkspaces({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" })),
    );
    await settle();
    act(() => {
      agentRun.resume("ws-2", "pane-2");
    });
    await settle();
    expect(agentRun.blocked["pane-2"]).toBe("/other");
    // Put back where it came from, not left rising.
    expect(background().idle).toMatchObject({ reason: "suspended" });

    // The folder comes back. Nothing has asked for the pane since the refusal,
    // so a plain sweep leaves it alone — the debt did not survive.
    ipc.probeWorktree.mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    pty.acquired = [];
    act(() => deck.renameWorkspace("ws-2", "two again"));
    await settle();
    expect(pty.acquired).toEqual([]);

    // Asking again re-owes it, and the pane starts even off screen.
    act(() => {
      agentRun.startFresh("ws-2", "pane-2");
    });
    await settle();
    expect(pty.acquired.map((a) => a.paneId)).toEqual(["pane-2"]);
  });

  it("refuses a pane no plugin can start, instead of stranding it", async () => {
    // The sweep skips a pane whose agent no plugin provides, so marking it
    // `waking` puts it somewhere nothing will ever settle: the durable
    // `suspended` stamp is gone from state (and from the next save), the
    // sweep won't touch it, and every "is this running" answer flips to yes
    // for an agent that cannot start. Refusing keeps the pane exactly as it
    // was, and the caller is told why.
    act(() =>
      deck.hydrate(
        twoWorkspaces({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" }),
      ),
    );
    await settle();
    act(() => {
      deck.workspaces[1].panes[0].agentType = "retired-cli";
    });

    expect(agentRun.resume("ws-2", "pane-2")).toBe("unavailable");
    expect(background().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T09:00:00.000Z",
    });
  });

  it("still leaves a RESTORED pane in a background workspace alone", async () => {
    // The lazy-revive policy is about panes that rise by themselves: waking a
    // whole background workspace at launch is what it exists to prevent.
    act(() => deck.hydrate(twoWorkspaces({ reason: "waking", origin: "restore" })));
    await settle();

    expect(background().idle).toEqual({ reason: "waking", origin: "restore" });
    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
  });
});

describe("agent orchestrator —what resume answers", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const only = (pane: object) =>
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1", agentType: "claude", ...pane }],
      }),
    );

  it("says a live pane has nothing to bring back", () => {
    // A caller reporting success for this would be lying, and the command
    // surfaces the answer as a sentence.
    only({});
    expect(agentRun.resume("ws-1", "pane-1")).toBe("running");
  });

  it("tells a pane mid-create apart from a running one", async () => {
    // Its own doc: telling the user a pane mid-create is already running is
    // simply false — it has never run, so there is no session to come back to.
    only({ provisioning: { repo: "/repo", workspace: "ws", index: 1 } });
    await settle();
    expect(agentRun.resume("ws-1", "pane-1")).toBe("provisioning");
  });

  it("says gone for a pane, and for a workspace, that is not there", () => {
    only({ idle: { reason: "parked" } });
    expect(agentRun.resume("ws-1", "nope")).toBe("gone");
    expect(agentRun.resume("nope", "pane-1")).toBe("gone");
  });
});

describe("agent orchestrator —a new pane arriving", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  /** One empty workspace with a setup command, its ref captured. */
  const instance = () => deck.workspaces[0].instance;
  const seed = (panes: Pane[] = []): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: "/wt",
        setup: "pnpm install",
        panes,
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const card = (over: object = {}): Pane => ({
    id: "pane-9",
    agentType: "claude",
    provisioning: { repo: "/repo", path: "/wt/a", workspace: "ws", index: 1 },
    ...over,
  });

  it("lands a plain pane and leaves the worktree runner alone", async () => {
    act(() => deck.hydrate(seed()));
    let outcome;
    await act(async () => {
      outcome = agentRun.createPane({
        workspace: { id: "ws-1", instance: instance() },
        pane: { id: "pane-9", agentType: "claude" },
      });
    });
    expect(outcome).toEqual({ kind: "created" });
    expect(deck.workspaces[0].panes.map((p) => p.id)).toEqual(["pane-9"]);
    expect(provisions).toEqual([]);
  });

  it("starts the worktree create behind a pane that arrives as a card", async () => {
    act(() => deck.hydrate(seed()));
    await act(async () => {
      agentRun.createPane({
        workspace: { id: "ws-1", instance: instance() },
        pane: card(),
      });
    });
    expect(provisions).toHaveLength(1);
    expect(provisions[0].panes.map((p) => p.id)).toEqual(["pane-9"]);
  });

  it("does NOT re-run the workspace's one-time setup for a pane added later", async () => {
    // The setup command prepares a worktree once, as part of the create
    // form's batch. A "+ Agent" pane joins a workspace already prepared, and
    // running it again per pane is not what "one-time" means.
    act(() => deck.hydrate(seed()));
    await act(async () => {
      agentRun.createPane({
        workspace: { id: "ws-1", instance: instance() },
        pane: card(),
      });
    });
    expect(provisions[0].setup).toBeUndefined();
  });

  /** Run the step the orchestrator handed over, as the worktree runner would,
   *  and report the command that reached the pane's slot. */
  const ranSetup = async (step: SetupStep | undefined) => {
    if (!step) return undefined;
    await step("pane-9", { cwd: "/wt/a", branch: "kd/a" });
    return pty.ranOnce[pty.ranOnce.length - 1]?.args;
  };

  it("DOES run it for a pane the batch stamped", async () => {
    act(() => deck.hydrate(seed()));
    await act(async () => {
      agentRun.createPane({
        workspace: { id: "ws-1", instance: instance() },
        pane: card({
          provisioning: {
            repo: "/repo",
            baseDir: "/wt",
            runsSetup: true,
            workspace: "ws",
            index: 1,
          },
        }),
      });
    });
    expect(await ranSetup(provisions[0].setup)).toEqual(["-c", "pnpm install"]);
  });

  it("refuses a workspace whose id now names a REPLACEMENT", async () => {
    // `ws-N` is a reusable slot. A creation surface decides asynchronously —
    // a repo inspect, a worktree suggestion — and the workspace it started
    // from can be closed and its slot reissued before it gets here.
    act(() => deck.hydrate(seed()));
    const stale = instance();
    act(() => deck.hydrate(seed()));

    let outcome;
    await act(async () => {
      outcome = agentRun.createPane({
        workspace: { id: "ws-1", instance: stale },
        pane: card(),
      });
    });
    expect(outcome).toEqual({ kind: "gone" });
    expect(deck.workspaces[0].panes).toEqual([]);
    // Nothing was added, so nothing may be created on disk for it.
    expect(provisions).toEqual([]);
  });

  it("refuses a full workspace rather than provisioning an ownerless worktree", async () => {
    // The add is a silent no-op once the workspace is full. Kicking the
    // create off anyway would leave a git worktree on disk with no pane to
    // own it, and nothing that would ever clean it up.
    act(() =>
      deck.hydrate(
        seed(
          Array.from({ length: MAX_PANES }, (_, i) => ({
            id: `pane-${i + 1}`,
            agentType: "claude" as const,
          })),
        ),
      ),
    );
    let outcome;
    await act(async () => {
      outcome = agentRun.createPane({
        workspace: { id: "ws-1", instance: instance() },
        pane: card(),
      });
    });
    expect(outcome).toEqual({ kind: "full" });
    expect(deck.workspaces[0].panes).toHaveLength(MAX_PANES);
    expect(provisions).toEqual([]);
  });

  it("drops a refused pane's cached plan — nothing will ever run it", async () => {
    // The plan-first flows (a journal resume, a fork) build and cache a plan
    // keyed by the pane id BEFORE the pane exists. Pane ids are never reused,
    // so a plan left behind by a refusal sits in the cache for the life of
    // the process.
    act(() => deck.hydrate(seed()));
    const stale = instance();
    act(() => deck.hydrate(seed()));
    await buildResumeSpec(
      {} as SpawnPluginAccess,
      "claude",
      { paneId: "pane-9", workspace: { id: "ws-1", instance: stale }, cwd: "/repo" },
      ctx,
      "s-1",
      "manual",
    );
    expect(peekPaneSpawnSpec("pane-9")).toBeDefined();

    await act(async () => {
      agentRun.createPane({
        workspace: { id: "ws-1", instance: stale },
        pane: card(),
      });
    });
    expect(peekPaneSpawnSpec("pane-9")).toBeUndefined();
  });
});

describe("agent orchestrator —a new workspace", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const config = (over: Partial<SpawnConfig> = {}): SpawnConfig => ({
    name: "",
    cwd: "/repo",
    agentType: "claude",
    count: 0,
    worktreeBaseDir: null,
    ...over,
  });

  const create = (over: Partial<SpawnConfig> = {}) => {
    let result!: WorkspaceCreationResult;
    act(() => {
      result = agentRun.createWorkspace(config(over));
    });
    return result;
  };

  it("reuses the highest sequence after its workspace is deleted", () => {
    create();
    create();
    create();
    expect(deck.workspaces.map((ws) => [ws.id, ws.name])).toEqual([
      ["ws-1", "workspace-1"],
      ["ws-2", "workspace-2"],
      ["ws-3", "workspace-3"],
    ]);

    const oldInstance = deck.workspaces[2].instance;
    act(() => deck.closeWorkspace("ws-3"));
    create();

    expect(deck.workspaces.map((ws) => [ws.id, ws.name])).toEqual([
      ["ws-1", "workspace-1"],
      ["ws-2", "workspace-2"],
      ["ws-3", "workspace-3"],
    ]);
    expect(deck.workspaces[2].instance).not.toBe(oldInstance);
  });

  it("keeps advancing past the maximum when only an interior id is deleted", () => {
    create();
    create();
    create();

    act(() => deck.closeWorkspace("ws-2"));
    create();

    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-1", "ws-3", "ws-4"]);
  });

  it("allocates distinct ids to creates queued in the same React batch", () => {
    act(() => {
      agentRun.createWorkspace(config());
      agentRun.createWorkspace(config());
    });

    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-1", "ws-2"]);
  });

  it("can release and reuse the maximum inside one React batch", () => {
    create();
    create();
    create();

    act(() => {
      deck.closeWorkspace("ws-3");
      agentRun.createWorkspace(config());
    });

    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-1", "ws-2", "ws-3"]);
  });

  it("does not start a create when the numeric namespace is exhausted", () => {
    const maxId = `ws-${Number.MAX_SAFE_INTEGER}`;
    act(() =>
      deck.hydrate({
        workspaces: [
          {
            id: maxId,
            instance: createWorkspaceInstance(),
            name: "maximum",
            cwd: "/repo",
            worktreeBaseDir: null,
            panes: [],
          },
        ],
        activeId: maxId,
        journal: emptyJournal,
        viewByWs: {},
      }),
    );

    const result = create();

    expect(deck.workspaces.map((ws) => ws.id)).toEqual([maxId]);
    expect(result).toEqual({ ok: false, reason: "sequence-exhausted" });
    expect(provisions).toEqual([]);
  });

  it("hands the whole batch to the worktree runner in ONE call", async () => {
    // One call, not one per pane: the runner pins a single base commit across
    // the batch, so concurrent creates don't straddle a moving HEAD.
    create({ count: 3, worktreeBaseDir: "/wt", setup: "  pnpm install  " });
    expect(provisions).toHaveLength(1);
    expect(provisions[0].panes).toHaveLength(3);
    // The trimmed command reaches the pane's own slot when the step runs.
    await provisions[0].setup!("pane-1", { cwd: "/wt/a", branch: "kd/a" });
    expect(pty.ranOnce).toEqual([
      { paneId: "pane-1", args: ["-c", "pnpm install"] },
    ]);
  });

  it("does not reach the worktree runner at all without a base folder", () => {
    // No base folder means the agents run in the workspace cwd — there is
    // nothing to create, so the setup command has nowhere to run either.
    create({ count: 2, setup: "pnpm install" });
    expect(deck.workspaces[0].panes).toHaveLength(2);
    expect(provisions).toEqual([]);
  });
});

describe("agent orchestrator —retrying a failed worktree create", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  /** A workspace with a setup command and one FAILED provisioning card. */
  const failedCard = (intent: object) =>
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws-1",
        cwd: "/repo",
        worktreeBaseDir: null,
        setup: "pnpm i",
        panes: [
          {
            id: "pane-1",
            agentType: "claude",
            provisioning: {
              repo: "/repo",
              workspace: "ws-1",
              index: 1,
              error: "boom",
              ...intent,
            },
          },
        ],
      }),
    );

  it("clears the error before re-issuing, so the card goes back to creating", () => {
    failedCard({ path: "/repo-wt/x", branch: "kd/x" });
    act(() => agentRun.retryProvisioning("ws-1", "pane-1"));
    expect(deck.workspaces[0].panes[0].provisioning?.error).toBeUndefined();
    expect(provisions).toHaveLength(1);
  });

  it("re-runs setup ONLY for batch panes — a dialog/fork retry must not widen the attempt", () => {
    // Dialog/fork intent: exact `path`, no baseDir → the initial run never
    // executed setup, so the retry must not either.
    failedCard({ path: "/repo-wt/x", branch: "kd/x" });
    act(() => agentRun.retryProvisioning("ws-1", "pane-1"));
    expect(provisions[0].setup).toBeUndefined();
  });

  it("batch panes (runsSetup intent) keep their setup on retry", async () => {
    failedCard({ baseDir: "/repo-wt", runsSetup: true });
    act(() => agentRun.retryProvisioning("ws-1", "pane-1"));
    await provisions[0].setup!("pane-1", { cwd: "/repo-wt/a", branch: "kd/a" });
    expect(pty.ranOnce).toEqual([{ paneId: "pane-1", args: ["-c", "pnpm i"] }]);
  });

  it("an auto-placed pane WITHOUT the runsSetup stamp still skips setup on retry", () => {
    // The discriminator is the explicit stamp, not baseDir's presence — a
    // future auto-placing dialog flow must not accidentally widen Retry.
    failedCard({ baseDir: "/repo-wt" });
    act(() => agentRun.retryProvisioning("ws-1", "pane-1"));
    expect(provisions[0].setup).toBeUndefined();
  });

  it("ignores a pane with no create intent, and one that is not there", () => {
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws-1",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1", agentType: "claude" }],
      }),
    );
    act(() => agentRun.retryProvisioning("ws-1", "pane-1"));
    act(() => agentRun.retryProvisioning("ws-1", "nope"));
    expect(provisions).toEqual([]);
  });
});

/** One empty workspace to continue a session into. */
const emptyWorkspace = () =>
  act(() =>
    deck.createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws-1",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [],
    }),
  );

const handle = (over: Partial<SessionHandle> = {}): SessionHandle =>
  ({
    agent: "codex",
    sessionId: "s-1",
    cwd: "/repo/wt",
    branch: "kd/x/1",
    yolo: true,
    // The plugin's fork hook needs the SOURCE transcript; without it a fork
    // lands in an empty conversation with a wrong usage baseline.
    transcriptPath: "/t/s-1.jsonl",
    ...over,
  }) as SessionHandle;

const fillWorkspace = () =>
  act(() => {
    for (let i = 0; i < MAX_PANES; i++) {
      deck.addAgentPane("ws-1", { id: `p-${i}`, agentType: "claude" });
    }
  });

describe("agent orchestrator —suspending an agent", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    vi.mocked(dropPaneSpawnSpec).mockClear();
    usage.clearPaneUsage.mockClear();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const seed = (over: Partial<Pane> = {}) =>
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-1",
            agentType: "codex",
            cwd: "/worktree",
            branch: "feature/x",
            session: { id: "s-1", boundAt: "2026-07-25T09:00:00.000Z" },
            ...over,
          },
        ],
      }),
    );

  const pane = () => deck.workspaces[0].panes[0];

  it("stops the process but keeps the pane, its worktree and its resume key", async () => {
    seed();
    await act(async () => agentRun.suspend("ws-1", "pane-1"));

    expect(pty.closed).toEqual(["pane-1"]);
    expect(pane()).toEqual({
      id: "pane-1",
      agentType: "codex",
      cwd: "/worktree",
      branch: "feature/x",
      session: { id: "s-1", boundAt: "2026-07-25T09:00:00.000Z" },
      idle: { reason: "suspended", at: expect.any(String) },
    });
  });

  it("marks the pane idle BEFORE reaping, so no sweep can respawn it mid-flight", async () => {
    seed();
    // A teardown that never finishes: the pane must ALREADY be out of the run
    // sweep's reach while its process is still going down. Reaping first would
    // leave a live, plan-less pane across that await — long enough for the
    // sweep to hand it a fresh plan and a NEW process, which this suspend
    // would then orphan (unmounting a view never kills a session).
    pty.hold = new Promise<void>(() => {});

    await act(async () => {
      void agentRun.suspend("ws-1", "pane-1");
    });

    expect(pty.closed).toEqual(["pane-1"]);
    expect(pane().idle).toEqual({ reason: "suspended", at: expect.any(String) });
  });

  it("revokes the bridge token and drops the pane's usage", async () => {
    seed();
    await act(async () => agentRun.suspend("ws-1", "pane-1"));
    expect(vi.mocked(dropPaneSpawnSpec)).toHaveBeenCalledWith("pane-1");
    expect(usage.clearPaneUsage).toHaveBeenCalledWith("pane-1");
  });

  it("reports the in-flight refusal apart from every other one", async () => {
    seed();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    let first!: Promise<SuspendOutcome>;
    act(() => {
      first = agentRun.suspend("ws-1", "pane-1");
    });
    // Distinct from "stopped": the pane is not down yet, someone is taking
    // it down.
    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "in-flight",
    );
    act(() => release());
    expect(await act(async () => first)).toBe("suspended");
    expect(pty.closed).toEqual(["pane-1"]);
  });

  it("names the reason it refuses, so every surface can say the same thing", async () => {
    // A bare `false` forced each caller to guess, and one guessed wrong: it
    // told a remote pane's user their running agent had no session to stop.
    seed({ provisioning: { repo: "/repo", workspace: "ws", index: 1 } });
    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "provisioning",
    );
    expect(await act(async () => agentRun.suspend("ws-1", "nope"))).toBe("gone");
    expect(await act(async () => agentRun.suspend("nope", "pane-1"))).toBe(
      "gone",
    );
    expect(pty.closed).toEqual([]);
    expect(pane().idle).toBeUndefined();
  });

  it("refuses a pane that is ALREADY stopped, whatever put it there", async () => {
    // Without this a second gesture re-runs the whole teardown on a pane with
    // no process — and, for a suspended one, restamps its card.
    seed({ idle: { reason: "suspended", at: "2026-07-25T08:00:00.000Z" } });
    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "stopped",
    );
    expect(pty.closed).toEqual([]);
    expect(vi.mocked(dropPaneSpawnSpec)).not.toHaveBeenCalled();
    expect(pane().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T08:00:00.000Z",
    });
  });

  it("refuses a REMOTE pane BY NAME — its session lives on the server", async () => {
    seed({ remoteEndpoint: "ws://vps:4500" });
    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "remote",
    );
    expect(pty.closed).toEqual([]);
    expect(pane().idle).toBeUndefined();
  });

  it("refuses a pane the SWEEP found stuck on a gone folder", async () => {
    // It has no process and is going nowhere until someone relocates it; its
    // tile is already dimmed and its tray chip already carries the stopped
    // marker. This gesture was the last surface still treating it as running,
    // and taking it would write a durable `suspended` stamp over a pane whose
    // real problem is a missing directory. The verdict comes from the sweep
    // itself — the gesture and the sweep now share one owner.
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    seed({ idle: { reason: "waking", origin: "restore" } });
    await settle();
    expect(agentRun.blocked).toEqual({ "pane-1": "/worktree" });

    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "stopped",
    );
    expect(pty.closed).toEqual([]);
  });

  it("still suspends a pane that is merely RISING — that cancels the wake", async () => {
    // The mirror of the case above: without a block, a pane on its way up is
    // a live target. Panes wait in `waking` for as long as their probe takes,
    // and refusing every idle pane made them unparkable in that window.
    seed({ idle: { reason: "waking", origin: "restore" } });
    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "suspended",
    );
    expect(pty.closed).toEqual(["pane-1"]);
  });

  it("survives its workspace closing mid-reap, and releases the pane afterwards", async () => {
    seed();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first!: Promise<SuspendOutcome>;
    act(() => {
      first = agentRun.suspend("ws-1", "pane-1");
    });
    act(() => deck.closeWorkspace("ws-1"));
    // Resolves rather than throwing on the vanished pane…
    expect(
      await act(async () => {
        release();
        return first;
      }),
    ).toBe("suspended");
    expect(deck.workspaces).toHaveLength(0);

    // …and the guard is released, so the id is usable again. A leaked entry
    // would make that pane unsuspendable for the rest of the session.
    pty.reset();
    seed();
    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "suspended",
    );
    expect(pty.closed).toEqual(["pane-1"]);
  });
});

describe("agent orchestrator —closing panes and workspaces", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    vi.mocked(dropPaneSpawnSpec).mockClear();
    usage.clearPaneUsage.mockClear();
    steps.clear.mockClear();
    discardFailures = [];
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          { id: "pane-1", agentType: "claude" },
          { id: "pane-2", agentType: "claude", cwd: "/wt/2", branch: "kd/ws/2" },
        ],
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    published.clear();
  });

  const target = { repo: "/repo", path: "/wt/2", branch: "kd/ws/2" };

  it("takes one pane out of the deck and ends exactly its process", async () => {
    await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-1",
        deleteWorktrees: false,
        worktrees: [],
      }),
    );
    expect(deck.workspaces[0].panes.map((p) => p.id)).toEqual(["pane-2"]);
    expect(pty.closed).toEqual(["pane-1"]);
    expect(vi.mocked(dropPaneSpawnSpec)).toHaveBeenCalledWith("pane-1");
    expect(usage.clearPaneUsage).toHaveBeenCalledWith("pane-1");
    // An abandoned fork card's post-provision step goes too: no Retry is
    // coming for a pane that is gone.
    expect(steps.clear).toHaveBeenCalledWith("pane-1");
  });

  it("closing a workspace ends every pane it held", async () => {
    await act(async () =>
      agentRun.close({
        kind: "workspace",
        wsId: "ws-1",
        deleteWorktrees: false,
        worktrees: [],
      }),
    );
    expect(deck.workspaces).toHaveLength(0);
    expect(pty.closed).toEqual(["pane-1", "pane-2"]);
    expect(vi.mocked(dropPaneSpawnSpec).mock.calls).toEqual([
      ["pane-1"],
      ["pane-2"],
    ]);
  });

  it("revokes the bridge token BEFORE the reducer forgets the pane", async () => {
    // The reverse of a suspend's order, and deliberately: a reporter still in
    // flight — or a later pane reusing the id — must not be able to write.
    const order: string[] = [];
    vi.mocked(dropPaneSpawnSpec).mockImplementationOnce(() => {
      order.push(`revoked:${deck.workspaces[0].panes.length}`);
    });
    await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-1",
        deleteWorktrees: false,
        worktrees: [],
      }),
    );
    expect(order).toEqual(["revoked:2"]);
  });

  it("removes worktrees only AFTER the processes are reaped", async () => {
    // A directory that is still some agent's cwd cannot be removed.
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closing!: Promise<string[]>;
    act(() => {
      closing = agentRun.close({
        kind: "workspace",
        wsId: "ws-1",
        deleteWorktrees: true,
        worktrees: [target],
      });
    });
    expect(discards).toEqual([]);
    await act(async () => {
      release();
      await closing;
    });
    expect(discards).toEqual([[target]]);
  });

  it("reports back what it could not delete, rather than swallowing it", async () => {
    discardFailures = ["kd/ws/2: still in use"];
    const failures = await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-2",
        deleteWorktrees: true,
        worktrees: [target],
      }),
    );
    expect(failures).toEqual(["kd/ws/2: still in use"]);
  });

  it("never reaches the worktree runner when nothing was asked for", async () => {
    const failures = await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-2",
        deleteWorktrees: false,
        worktrees: [],
      }),
    );
    expect(failures).toEqual([]);
    expect(discards).toEqual([]);
  });

  it("deletes what a still-running create put on disk, without waiting for the rest of it", async () => {
    // A pane mid-create has no cwd, so it contributes no ordinary target. The
    // create publishes the directory the moment `git worktree add` returns,
    // which is what lets this close name it — and lets it settle even though
    // the create's setup step is stuck in the session slot about to be reaped.
    const made = { repo: "/repo", path: "/wt/9", branch: "kd/ws/9" };
    published.set("pane-1", Promise.resolve(made));

    const failures = await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-1",
        deleteWorktrees: true,
        worktrees: [],
      }),
    );

    expect(failures).toEqual([]);
    expect(discards).toEqual([[made]]);
  });

  it("removes what a create landed while the dialog was still open", async () => {
    // The dialog's list is frozen when it opens. A create finishing while the
    // user reads it turns a pane the dialog called "still being created" into
    // one that owns a worktree — which that frozen list will never mention.
    // Deciding from the live deck is what covers it.
    act(() =>
      deck.createWorkspace({
        id: "ws-2",
        instance: createWorkspaceInstance(),
        name: "two",
        cwd: "/repo",
        worktreeBaseDir: "/wt",
        panes: [
          {
            id: "pane-9",
            agentType: "claude",
            provisioning: { repo: "/repo", workspace: "two", index: 1 },
          },
        ],
      }),
    );
    // …the create lands while the confirm dialog is up.
    act(() =>
      deck.resolvePaneProvisioning("ws-2", "pane-9", {
        cwd: "/wt/late",
        branch: "kd/ws/late",
      }),
    );
    expect(deck.workspaces[1].panes[0].cwd).toBe("/wt/late");

    await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-2",
        paneId: "pane-9",
        deleteWorktrees: true,
        // Exactly what the dialog offered when it opened: nothing.
        worktrees: [],
      }),
    );

    expect(discards).toEqual([
      [{ repo: "/repo", path: "/wt/late", branch: "kd/ws/late" }],
    ]);
  });

  it("deletes nothing when the box was left unticked", async () => {
    published.set(
      "pane-1",
      Promise.resolve({ repo: "/repo", path: "/wt/9", branch: "kd/ws/9" }),
    );
    await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-1",
        deleteWorktrees: false,
        worktrees: [],
      }),
    );
    expect(discards).toEqual([]);
    // Consumed all the same, so no published entry is left behind.
    expect(published.has("pane-1")).toBe(false);
  });

  it("names one worktree once, however many sources mention it", async () => {
    const target = { repo: "/repo", path: "/wt/2", branch: "kd/ws/2" };
    published.set("pane-2", Promise.resolve(target));

    await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-2",
        deleteWorktrees: true,
        // pane-2 already owns /wt/2, so the deck names it too.
        worktrees: [target],
      }),
    );

    expect(discards).toEqual([[target]]);
  });

  it("still reaps a pane whose reap REJECTS, and the rest with it", async () => {
    // One process refusing to die must not strand the others, nor leave the
    // worktree removal waiting on a promise that never settles.
    pty.hold = Promise.reject(new Error("pty gone"));
    const failures = await act(async () =>
      agentRun.close({
        kind: "workspace",
        wsId: "ws-1",
        deleteWorktrees: true,
        worktrees: [target],
      }),
    );
    expect(failures).toEqual([]);
    expect(discards).toEqual([[target]]);
  });
});

describe("agent orchestrator —restarting an exited agent", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    vi.mocked(buildResumeSpec).mockReset();
    vi.mocked(dropPaneSpawnSpec).mockClear();
    vi.mocked(clearPanePlanError).mockClear();
    usage.clearPaneUsage.mockClear();
    gate.build = null;
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const seed = (sessionId: string | null = "session-old") =>
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-1",
            agentType: "codex",
            cwd: "/worktree",
            branch: "feature/restart",
            yolo: true,
            ...(sessionId
              ? { session: { id: sessionId, boundAt: "2026-07-11T00:00:00Z" } }
              : {}),
          },
        ],
      }),
    );

  const pane = () => deck.workspaces[0].panes[0];
  const epoch = () => agentRun.epochs["pane-1"];
  /** A second workspace to switch to, leaving ws-1 off screen. */
  const otherWorkspace = () => ({
    id: "ws-2",
    instance: createWorkspaceInstance(),
    name: "two",
    cwd: "/other",
    worktreeBaseDir: null,
    panes: [],
  });

  it("resumes the exact binding with a new plan and keeps the pane's facts", async () => {
    seed();
    await act(async () => agentRun.restart("ws-1", "pane-1", "resume"));

    expect(vi.mocked(buildResumeSpec)).toHaveBeenCalledWith(
      expect.anything(),
      "codex",
      {
        paneId: "pane-1",
        workspace: { id: "ws-1", instance: deck.workspaces[0].instance },
        cwd: "/worktree",
        branch: "feature/restart",
        yolo: true,
        wsSkillRoots: ["/worktree"],
      },
      ctx,
      "session-old",
      "manual",
    );
    expect(pty.closed).toEqual(["pane-1"]);
    expect(usage.clearPaneUsage).toHaveBeenCalledWith("pane-1");
    expect(epoch()).toBe(1);
    expect(pane()).toMatchObject({
      cwd: "/worktree",
      branch: "feature/restart",
      session: { id: "session-old" },
    });
  });

  it("starts fresh only on click, clearing the binding but keeping the worktree", async () => {
    seed();
    await act(async () => agentRun.restart("ws-1", "pane-1", "fresh"));

    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
    expect(pty.closed).toEqual(["pane-1"]);
    expect(usage.clearPaneUsage).toHaveBeenCalledWith("pane-1");
    expect(pane()).toMatchObject({
      cwd: "/worktree",
      branch: "feature/restart",
    });
    expect(pane().session).toBeUndefined();
    expect(epoch()).toBe(1);
  });

  it("a suspend landing mid-restart keeps its binding — neither gesture blocks the other", async () => {
    // Suspending and restarting hold SEPARATE guards, so ⇧⌘W slips inside the
    // restart's reap. The pane is parked by the time the restart resumes, and
    // its binding is exactly what its resume needs: wiping it would turn the
    // user's suspend into a new conversation.
    seed();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    let restarting!: Promise<unknown>;
    act(() => {
      restarting = agentRun.restart("ws-1", "pane-1", "fresh");
    });
    act(() => deck.suspendPane("ws-1", "pane-1"));
    await act(async () => {
      release();
      await restarting;
    });

    expect(pane().session).toEqual({
      id: "session-old",
      boundAt: "2026-07-11T00:00:00Z",
    });
    expect(pane().idle).toMatchObject({ reason: "suspended" });
    // No remount either: the pane is stopped, there is nothing to mount.
    expect(epoch()).toBeUndefined();
  });

  it("a suspend landing mid-RESUME leaves the pane stopped, not remounted", async () => {
    // Every field the resume path compares survives a suspend untouched, so
    // the idle marker is the only thing that says the user changed their mind.
    // Without that check the epoch bump would remount the pane the suspend
    // just stopped — a stopped card that spawns a terminal on its own.
    seed();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    let restarting!: Promise<unknown>;
    act(() => {
      restarting = agentRun.restart("ws-1", "pane-1", "resume");
    });
    // The plan is built before the reap, so let it settle, then suspend.
    await act(async () => {});
    act(() => deck.suspendPane("ws-1", "pane-1"));
    await act(async () => {
      release();
      await restarting;
    });

    expect(pane().idle).toMatchObject({ reason: "suspended" });
    expect(pane().session).toEqual({
      id: "session-old",
      boundAt: "2026-07-11T00:00:00Z",
    });
    expect(epoch()).toBeUndefined();
  });

  it("falls back to fresh safely when resume was asked for without a binding", async () => {
    seed(null);
    await act(async () => agentRun.restart("ws-1", "pane-1", "resume"));

    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
    expect(pty.closed).toEqual(["pane-1"]);
    expect(epoch()).toBe(1);
  });

  it("restarts a REMOTE pane fresh even with a stale binding clinging to it", async () => {
    // Resuming it locally would drop the endpoint. The target's session id is
    // null for a remote pane, so the restart falls through to fresh.
    seed();
    act(() => {
      pane().remoteEndpoint = "ws://vps:4500";
    });
    await act(async () => agentRun.restart("ws-1", "pane-1", "resume"));

    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
    expect(pty.closed).toEqual(["pane-1"]);
    expect(epoch()).toBe(1);
  });

  it("coalesces repeated clicks while one restart is in flight", async () => {
    seed();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    let first!: Promise<unknown>;
    act(() => {
      first = agentRun.restart("ws-1", "pane-1", "fresh");
      void agentRun.restart("ws-1", "pane-1", "fresh");
    });
    expect(pty.closed).toEqual(["pane-1"]);
    await act(async () => {
      release();
      await first;
    });
    expect(epoch()).toBe(1);
  });

  it("does not resurrect a pane closed while its resume plan is building", async () => {
    seed();
    let release!: () => void;
    gate.build = new Promise<void>((resolve) => {
      release = resolve;
    });

    let pending!: Promise<unknown>;
    act(() => {
      pending = agentRun.restart("ws-1", "pane-1", "resume");
    });
    act(() => deck.closeAgent("ws-1", "pane-1"));
    await act(async () => {
      release();
      await pending;
    });

    expect(pty.closed).toEqual([]);
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined();
    expect(epoch()).toBeUndefined();
  });

  it("keeps the pane exited when a manual resume plan cannot be prepared", async () => {
    seed();
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);

    await expect(
      act(async () => agentRun.restart("ws-1", "pane-1", "resume")),
    ).rejects.toThrow("could not prepare a resume plan");

    expect(pty.closed).toEqual([]);
    expect(epoch()).toBeUndefined();
    expect(pane().session?.id).toBe("session-old");
  });

  it("revokes the retired process's token BEFORE building the replacement's plan", async () => {
    // A restart is only ever offered on a pane whose process has already ended
    // — the exit card is its one entry point — so the credential being dropped
    // belongs to a dead process. Building first would let the new plan inherit
    // it (the cache mints a fresh token only when no spec is present), and a
    // late bridge envelope, or a child that outlived the PTY, could then still
    // echo it and rebind this pane.
    seed();
    await settle();
    vi.mocked(dropPaneSpawnSpec).mockClear();
    vi.mocked(buildResumeSpec).mockClear();

    await act(async () => agentRun.restart("ws-1", "pane-1", "resume"));

    const dropped = vi.mocked(dropPaneSpawnSpec).mock.invocationCallOrder[0];
    const built = vi.mocked(buildResumeSpec).mock.invocationCallOrder[0];
    expect(dropped).toBeLessThan(built);
    expect(epoch()).toBe(1);
  });

  it("blames the suspend, not the agent, when one lands inside the build", async () => {
    // A real suspend drops the pane's spec, which retires this build's
    // generation by design, so the plan comes back unbuilt. Reading that as
    // "the agent could not prepare a plan" put a failure on the card of a pane
    // the user had just parked on purpose.
    seed();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // What the real cache does when a suspend drops the spec mid-build: the
    // build loses its generation and reports that it cached nothing.
    vi.mocked(buildResumeSpec).mockImplementationOnce(async () => {
      await held;
      return false;
    });

    let pending!: Promise<RestartOutcome>;
    act(() => {
      pending = agentRun.restart("ws-1", "pane-1", "resume");
    });
    act(() => {
      void agentRun.suspend("ws-1", "pane-1");
    });
    await act(async () => {
      release();
      await expect(pending).resolves.toBe("stopped");
    });

    expect(pane().idle).toMatchObject({ reason: "suspended" });
    expect(epoch()).toBeUndefined();
  });

  it("mounts the prepared plan when the pane moves under the reap, never a fresh one", async () => {
    // Past the reap the process is already gone, so standing down is not on
    // offer: the sweep sees a pane that should run with no process and would
    // build a FRESH plan for it — turning the resume the user named by hand
    // into a brand-new conversation whose reporter then overwrites the
    // binding. The prepared plan is mounted instead.
    seed();
    await settle();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    let pending!: Promise<RestartOutcome>;
    act(() => {
      pending = agentRun.restart("ws-1", "pane-1", "resume");
    });
    // The plan is built before the reap, so let it settle first — this has to
    // land inside `sessions.close`, which is the window the pre-reap checks
    // cannot cover.
    await act(async () => {});
    // A late postback binds a different session while the reap is out.
    act(() =>
      deck.setPaneSession("ws-1", "pane-1", {
        id: "session-new",
        boundAt: "2026-07-12T00:00:00Z",
      }),
    );
    await act(async () => {
      release();
      await expect(pending).resolves.toBe("changed");
    });

    // The remount happened, and the plan behind it is still the manual resume
    // of the session that was asked for — not a fresh spawn.
    expect(epoch()).toBe(1);
    expect(peekPaneSpawnSpec("pane-1")).toMatchObject({
      resumeOrigin: "manual",
      resumeOf: "session-old",
    });
  });

  it("does not let the SWEEP spawn the process it is retiring", async () => {
    // Closing the session empties the slot, which reads to the sweep exactly
    // like a pane that should be started. Spawning there would race the
    // restart's own continuation, which then finishes against a process it
    // did not start — and its stand-down path revokes a LIVE process's bridge
    // token, silencing that agent's reports for the rest of its life.
    seed();
    await settle();
    pty.acquired = [];
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    let pending!: Promise<unknown>;
    act(() => {
      pending = agentRun.restart("ws-1", "pane-1", "resume");
    });
    await settle();
    expect(pty.acquired).toEqual([]);

    // …and once it is done, the sweep is told to look again.
    await act(async () => {
      release();
      await pending;
    });
    await settle();
    expect(pty.acquired.map((a) => a.paneId)).toEqual(["pane-1"]);
  });

  it("says it stood down when a suspend beat it, instead of reporting success", async () => {
    // The card clears its "Restarting…" state on this answer. Reading a
    // resolved promise as a restart left it promising one that never came.
    seed();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending!: Promise<unknown>;
    act(() => {
      pending = agentRun.restart("ws-1", "pane-1", "fresh");
    });
    act(() => deck.suspendPane("ws-1", "pane-1"));
    let outcome: unknown;
    await act(async () => {
      release();
      outcome = await pending;
    });
    expect(outcome).toBe("stopped");
  });

  it("refuses a second click by name, and a pane that is gone", async () => {
    seed();
    pty.hold = new Promise<void>(() => {});
    act(() => {
      void agentRun.restart("ws-1", "pane-1", "fresh");
    });
    expect(await act(async () => agentRun.restart("ws-1", "pane-1", "fresh"))).toBe(
      "in-flight",
    );
    expect(await act(async () => agentRun.restart("ws-1", "nope", "fresh"))).toBe(
      "gone",
    );
  });

  it("retryPlanBuild drops the failure and the half-built plan, without a reap", async () => {
    seed();
    act(() => agentRun.retryPlanBuild("pane-1"));

    expect(vi.mocked(dropPaneSpawnSpec)).toHaveBeenCalledWith("pane-1");
    expect(vi.mocked(clearPanePlanError)).toHaveBeenCalledWith("pane-1");
    expect(epoch()).toBe(1);
    // No process was ever started for a failed-plan pane — nothing to close.
    expect(pty.closed).toEqual([]);
  });

  it("publishes a failed build as the error tile, and clears it on retry", async () => {
    // The tile is what a pane whose plan could not be built shows instead of
    // hanging on "Waking up…" forever, and the retry is the only way off it.
    seed();
    await settle();
    act(() => {
      plans.failed.add("pane-1");
      plans.notify();
    });
    expect([...agentRun.planFailed]).toEqual(["pane-1"]);

    act(() => agentRun.retryPlanBuild("pane-1"));
    await settle();
    expect([...agentRun.planFailed]).toEqual([]);
    expect(agentRun.specs["pane-1"]).toBeDefined();
  });

  it("answers what a restart DID, for every way it can end", async () => {
    // The card clears its spinner on any answer but "restarted", so a wrong
    // literal either strands it or clears it too early.
    seed();
    await settle();
    expect(await act(async () => agentRun.restart("ws-1", "pane-1", "fresh"))).toBe(
      "restarted",
    );
    expect(await act(async () => agentRun.restart("ws-1", "nope", "fresh"))).toBe(
      "gone",
    );
  });

  it("retryPlanBuild actually REBUILDS — the tile's retry is not just a reset", async () => {
    // Dropping the failed plan is half a retry. Nothing else was listening to
    // that cache, so the sweep never re-ran and the error tile turned into a
    // permanent "Waking up…" spinner with its retry button gone.
    seed();
    await settle();
    expect(peekPaneSpawnSpec("pane-1")).toBeDefined();

    act(() => agentRun.retryPlanBuild("pane-1"));
    await settle();

    expect(peekPaneSpawnSpec("pane-1")).toBeDefined();
    expect(agentRun.specs["pane-1"]).toBeDefined();
  });

  it("auto-recovers a rejected BOOT resume exactly once", async () => {
    seed();
    plans.specs.set("pane-1", {
      args: ["resume", "session-old"],
      env: [],
      resumeOf: "session-old",
      resumeOrigin: "restore",
      postbackMark: 0,
    });

    act(() => {
      agentRun.recoverRejectedResume("ws-1", "pane-1", 1);
    });
    await act(async () => {});

    expect(pty.closed).toEqual(["pane-1"]);
    expect(usage.clearPaneUsage).toHaveBeenCalledWith("pane-1");
    expect(pane().session).toBeUndefined();
    expect(epoch()).toBe(1);
    // The spec is gone, so the predicate answers false for the next exit.
    act(() => {
      agentRun.recoverRejectedResume("ws-1", "pane-1", 1);
    });
    expect(pty.closed).toEqual(["pane-1"]);
  });

  it("keeps the promise it makes the caller — respawns even off screen", async () => {
    // It answers `true`, which is how App knows this exit is a respawn and not
    // a crash worth notifying about. The respawn is the sweep's job now, and
    // the sweep holds a pane whose workspace nobody has opened — so the pane
    // was left with its binding wiped, no process, and nothing saying so.
    seed();
    act(() => deck.createWorkspace(otherWorkspace()));
    act(() => deck.selectWorkspace("ws-2"));
    await settle();
    pty.acquired = [];
    plans.specs.set("pane-1", {
      args: ["resume", "session-old"],
      env: [],
      resumeOf: "session-old",
      resumeOrigin: "restore",
      postbackMark: 0,
    });

    let recovering: unknown;
    act(() => {
      recovering = agentRun.recoverRejectedResume("ws-1", "pane-1", 1);
    });
    await settle();

    expect(recovering).toBe(true);
    expect(pane().session).toBeUndefined();
    expect(pty.acquired.map((a) => a.paneId)).toEqual(["pane-1"]);
  });

  it("never auto-recovers an ordinary exit or a rejected MANUAL resume", () => {
    seed();
    plans.specs.set("pane-1", {
      args: ["resume", "session-old"],
      env: [],
      resumeOf: "session-old",
      resumeOrigin: "manual",
      postbackMark: 0,
    });

    act(() => {
      expect(agentRun.recoverRejectedResume("ws-1", "pane-1", 1)).toBe(false);
    });
    expect(pty.closed).toEqual([]);
    expect(epoch()).toBeUndefined();
    expect(pane().session?.id).toBe("session-old");
  });
});

describe("agent orchestrator —continuing a recorded session", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
    emptyWorkspace();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("mints a pane carrying the record's shape and a pre-claimed session", async () => {
    await act(async () => agentRun.resumeSession("ws-1", handle()));

    const panes = deck.workspaces[0].panes;
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({
      agentType: "codex",
      cwd: "/repo/wt", // foreign dir → pinned (the session's worktree)
      branch: "kd/x/1",
      yolo: true,
      session: { id: "s-1" },
    });
    // Built for that pane, as a MANUAL resume: a continuation the user asked
    // for must not quietly become a different conversation.
    expect(peekPaneSpawnSpec(panes[0].id)).toMatchObject({
      resumeOf: "s-1",
      resumeOrigin: "manual",
    });
  });

  it("leaves a session recorded in the workspace's OWN folder a plain pane", async () => {
    await act(async () =>
      agentRun.resumeSession("ws-1", handle({ cwd: "/repo", branch: undefined })),
    );
    expect(deck.workspaces[0].panes[0].cwd).toBeUndefined();
  });

  it("refuses a session another pane already holds, LOUDLY", async () => {
    // The browser offers Resume for every row — it cannot know lifecycle. An
    // enabled button that silently does nothing reads as dead.
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-77",
        agentType: "codex",
        session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
      }),
    );
    await expect(
      act(async () => agentRun.resumeSession("ws-1", handle())),
    ).rejects.toThrow("already running");
    expect(deck.workspaces[0].panes).toHaveLength(1);
    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
  });

  it("points at the pane that HOLDS the session when that pane is stopped", async () => {
    // "Already running" would be false and useless: the pane is stopped, and
    // the thing to do is resume it there, where its card has the button.
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-77",
        agentType: "codex",
        session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
      }),
    );
    act(() => deck.suspendPane("ws-1", "pane-77"));

    await expect(
      act(async () => agentRun.resumeSession("ws-1", handle())),
    ).rejects.toThrow("stopped pane");
  });

  it("calls a claimant stuck on a gone folder stopped, not running", async () => {
    // Its own marker still says `waking`; only the sweep's runtime verdict
    // knows it will never get there. Without that verdict the message sent
    // the user looking for a running agent that isn't.
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-77",
        agentType: "codex",
        cwd: "/gone/worktree",
        session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
      }),
    );
    act(() => deck.suspendPane("ws-1", "pane-77"));
    act(() => deck.requestPaneWake("ws-1", "pane-77"));
    await settle();
    expect(agentRun.blocked).toEqual({ "pane-77": "/gone/worktree" });

    await expect(
      act(async () => agentRun.resumeSession("ws-1", handle())),
    ).rejects.toThrow("stopped pane");
  });

  it("is not blocked by a FORK of the same session — they are not alternatives", async () => {
    // A fork copies the session, a resume claims it. Sharing one guard let a
    // fork's store surgery — seconds of export/rekey/import — swallow the
    // Resume beside it: no pane, no error, a dead button.
    let release!: () => void;
    vi.mocked(buildForkSpec).mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve(true);
      }),
    );
    act(() => {
      void agentRun.forkSession("ws-1", handle(), { kind: "dir", cwd: "/x" });
    });

    await act(async () => agentRun.resumeSession("ws-1", handle()));
    expect(deck.workspaces[0].panes.some((p) => p.session?.id === "s-1")).toBe(
      true,
    );
    await act(async () => release());
  });

  it("rejects — and mints no pane — when the plan cannot be prepared", async () => {
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);
    await expect(
      act(async () => agentRun.resumeSession("ws-1", handle())),
    ).rejects.toThrow("resume plan");
    expect(deck.workspaces[0].panes).toHaveLength(0);
  });

  it("fails a full workspace loudly instead of stranding the built plan", async () => {
    fillWorkspace();
    await expect(
      act(async () => agentRun.resumeSession("ws-1", handle())),
    ).rejects.toThrow("full");
    expect(deck.workspaces[0].panes).toHaveLength(MAX_PANES);
  });

  it("re-checks the claim after the async build — a concurrent binder wins", async () => {
    let release!: () => void;
    gate.build = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending!: Promise<void>;
    act(() => {
      pending = agentRun.resumeSession("ws-1", handle());
    });
    // The session gets claimed DURING the build (a revive landed).
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-claimer",
        agentType: "claude",
        session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
      }),
    );
    await act(async () => {
      release();
      await pending;
    });
    // Only the claimer exists — no second pane bound to the same session.
    expect(deck.workspaces[0].panes.map((p) => p.id)).toEqual(["pane-claimer"]);
  });

  it("drops the built plan — and SAYS so — when the workspace died during the build", async () => {
    let release!: () => void;
    gate.build = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending!: Promise<void>;
    act(() => {
      pending = agentRun.resumeSession("ws-1", handle());
    });
    act(() => deck.closeWorkspace("ws-1"));
    await act(async () => {
      release();
      // Resolving here would tell the row's Resume it worked: no pane
      // appears, no alert fires, and the button reads as dead.
      await expect(pending).rejects.toThrow("closed");
    });

    expect(deck.workspaces).toHaveLength(0);
    // The plan finished building into a cache entry keyed by a pane that will
    // now never exist, and pane ids are never reused.
    const minted = vi.mocked(buildResumeSpec).mock.calls[0][2].paneId;
    expect(peekPaneSpawnSpec(minted)).toBeUndefined();
  });

  it("a YOLO override reaches the pane AND the plan's facts", async () => {
    await act(async () =>
      agentRun.resumeSession("ws-1", handle({ yolo: false }), { yolo: true }),
    );
    expect(deck.workspaces[0].panes[0].yolo).toBe(true);
    expect(vi.mocked(buildResumeSpec).mock.calls[0][2]).toMatchObject({
      yolo: true,
    });
  });

  it("a YOLO override=false disarms a resume of a YOLO source session", async () => {
    await act(async () =>
      agentRun.resumeSession("ws-1", handle({ yolo: true }), { yolo: false }),
    );
    expect(deck.workspaces[0].panes[0].yolo).toBeUndefined();
    expect(vi.mocked(buildResumeSpec).mock.calls[0][2]).toMatchObject({
      yolo: false,
    });
  });
});

describe("agent orchestrator —forking a recorded session", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    vi.mocked(buildForkSpec).mockClear();
    steps.register.mockClear();
    steps.clear.mockClear();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
    emptyWorkspace();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const forked = () => handle({ agent: "claude", cwd: "/old/wt", yolo: false });
  /** The step registered for the pane, as the worktree runner would call it. */
  const registeredStep = () =>
    steps.register.mock.calls[0][1] as (wt: {
      cwd: string;
      branch: string;
    }) => Promise<void>;

  it("dir target: mints an UNBOUND pane in the chosen dir with the fork plan", async () => {
    await act(async () =>
      agentRun.forkSession("ws-1", forked(), { kind: "dir", cwd: "/elsewhere" }),
    );

    const pane = deck.workspaces[0].panes[0];
    expect(pane).toMatchObject({ agentType: "claude", cwd: "/elsewhere" });
    // The fork's NEW session id arrives later, via the reporter.
    expect(pane.session).toBeUndefined();
    const call = vi.mocked(buildForkSpec).mock.calls[0];
    expect(call[2]).toMatchObject({ paneId: pane.id, cwd: "/elsewhere" });
    // Exact, not a subset: an extra or renamed field in the fork request is
    // as much a defect as a missing one.
    expect(call[4]).toEqual({
      sessionId: "s-1",
      sourceCwd: "/old/wt",
      transcriptPath: "/t/s-1.jsonl",
    });
  });

  it("the workspace's own folder stays a plain pane", async () => {
    await act(async () =>
      agentRun.forkSession("ws-1", forked(), { kind: "dir", cwd: "/repo" }),
    );
    expect(deck.workspaces[0].panes[0].cwd).toBeUndefined();
  });

  it("worktree target: a card first, and the surgery DEFERRED to a step", async () => {
    await act(async () =>
      agentRun.forkSession("ws-1", handle({ agent: "claude", yolo: true }), {
        kind: "worktree",
        path: "/repo-wt/fork-1",
        branch: "fork/auth",
      }),
    );

    const pane = deck.workspaces[0].panes[0];
    expect(pane.provisioning).toMatchObject({
      repo: "/repo",
      path: "/repo-wt/fork-1",
      branch: "fork/auth",
    });
    // The marker the whole restart-safety fix hinges on: serialize drops it.
    expect(pane.provisioning?.fork).toBe(true);
    expect(pane.yolo).toBe(true);
    // The worktree does not exist yet, so no surgery runs up front — a step
    // is registered and the ordinary create is kicked off behind the card.
    expect(vi.mocked(buildForkSpec)).not.toHaveBeenCalled();
    expect(steps.register).toHaveBeenCalledTimes(1);
    expect(steps.register.mock.calls[0][0]).toBe(pane.id);
    expect(provisions).toHaveLength(1);
    expect(provisions[0].panes.map((p) => p.id)).toEqual([pane.id]);

    // The step runs the surgery bound to the CREATED worktree's cwd —
    // deliberately DISTINCT from the requested path, proving it uses the
    // runner's answer and not the stale target.
    await registeredStep()({
      cwd: "/repo-wt/fork-1-created",
      branch: "fork/auth",
    });
    expect(vi.mocked(buildForkSpec).mock.calls[0][2]).toMatchObject({
      paneId: pane.id,
      cwd: "/repo-wt/fork-1-created",
    });
  });

  it("worktree target: the step THROWS when the surgery cannot prepare", async () => {
    vi.mocked(buildForkSpec).mockResolvedValueOnce(false);
    await act(async () =>
      agentRun.forkSession("ws-1", forked(), {
        kind: "worktree",
        path: "/repo-wt/f",
        branch: "fork/x",
      }),
    );
    // The runner relies on the throw to roll the worktree back and fail the
    // card (asserted in provisioning.test.ts); here: the step signals it.
    await expect(
      registeredStep()({ cwd: "/repo-wt/f", branch: "fork/x" }),
    ).rejects.toThrow("Agent could not prepare a fork plan");
  });

  it("worktree target: the step carries the plugin's OWN diagnostic through", async () => {
    vi.mocked(buildForkSpec).mockRejectedValueOnce(
      new Error("opencode fork: unexpected id layout"),
    );
    await act(async () =>
      agentRun.forkSession("ws-1", forked(), {
        kind: "worktree",
        path: "/repo-wt/f",
        branch: "fork/x",
      }),
    );
    // No masking try/catch, so the runner surfaces the precise message
    // instead of the generic one.
    await expect(
      registeredStep()({ cwd: "/repo-wt/f", branch: "fork/x" }),
    ).rejects.toThrow("unexpected id layout");
  });

  it("a full workspace fails loudly — no stranded step, no ownerless worktree", async () => {
    fillWorkspace();
    await expect(
      act(async () =>
        agentRun.forkSession("ws-1", forked(), {
          kind: "worktree",
          path: "/repo-wt/f",
          branch: "fork/x",
        }),
      ),
    ).rejects.toThrow("full");
    expect(provisions).toEqual([]);
    // The step was registered before the refusal; leaving it in the map would
    // hold a closure over a pane id that will never exist again.
    expect(steps.clear).toHaveBeenCalledTimes(1);
  });

  it("a full workspace fails a DIR fork BEFORE the irreversible surgery", async () => {
    fillWorkspace();
    await expect(
      act(async () =>
        agentRun.forkSession("ws-1", forked(), { kind: "dir", cwd: "/elsewhere" }),
      ),
    ).rejects.toThrow("full");
    // export→rekey→import never runs, so there is no orphan clone.
    expect(vi.mocked(buildForkSpec)).not.toHaveBeenCalled();
  });

  it("reports the closed workspace instead of orphaning the clone it just made", async () => {
    // The surgery is irreversible — export→rekey→import into the agent's own
    // store — and it has already run by the time the pane lands. A workspace
    // closing inside that await used to resolve the promise as if the fork
    // had worked: a cloned session left in the store forever, no pane, no
    // error, and a dialog that closed on success.
    let release!: () => void;
    vi.mocked(buildForkSpec).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(true);
        }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = agentRun.forkSession("ws-1", forked(), {
        kind: "dir",
        cwd: "/elsewhere",
      });
    });
    act(() => deck.closeWorkspace("ws-1"));
    await act(async () => {
      release();
      await expect(pending).rejects.toThrow("closed");
    });

    expect(vi.mocked(buildForkSpec)).toHaveBeenCalledOnce();
    expect(deck.workspaces).toHaveLength(0);
  });

  it("a throwing surgery carries its precise diagnostic to the caller", async () => {
    vi.mocked(buildForkSpec).mockRejectedValueOnce(
      new Error("kimi fork of s-1: unexpected store layout"),
    );
    await expect(
      act(async () =>
        agentRun.forkSession("ws-1", forked(), { kind: "dir", cwd: "/x" }),
      ),
    ).rejects.toThrow("unexpected store layout");
    expect(deck.workspaces[0].panes).toHaveLength(0);
  });

  it("rejects — and mints nothing — when the surgery cannot prepare a plan", async () => {
    vi.mocked(buildForkSpec).mockResolvedValueOnce(false);
    await expect(
      act(async () =>
        agentRun.forkSession("ws-1", forked(), { kind: "dir", cwd: "/x" }),
      ),
    ).rejects.toThrow("fork plan");
    expect(deck.workspaces[0].panes).toHaveLength(0);
    expect(provisions).toEqual([]);
  });

  it("a YOLO override reaches the pane AND the plan's facts", async () => {
    await act(async () =>
      agentRun.forkSession(
        "ws-1",
        forked(),
        { kind: "dir", cwd: "/x" },
        { yolo: true },
      ),
    );
    expect(deck.workspaces[0].panes[0].yolo).toBe(true);
    expect(vi.mocked(buildForkSpec).mock.calls[0][2]).toMatchObject({
      yolo: true,
    });
  });

  it("a YOLO override=false disarms a fork of a YOLO source session", async () => {
    await act(async () =>
      agentRun.forkSession(
        "ws-1",
        handle({ agent: "claude", yolo: true }),
        { kind: "dir", cwd: "/x" },
        { yolo: false },
      ),
    );
    expect(deck.workspaces[0].panes[0].yolo).toBeUndefined();
    expect(vi.mocked(buildForkSpec).mock.calls[0][2]).toMatchObject({
      yolo: false,
    });
  });
});
