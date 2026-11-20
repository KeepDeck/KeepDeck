// @vitest-environment happy-dom
import { emptyJournal as emptyJournalImpl } from "../../domain/journal";
import { act, useState } from "react";
import { vi } from "vitest";
import type { DeckState, Pane, PaneIdle, SpawnConfig, TeamLocation } from "../../domain/deck";
import { MAX_PANES as MAX_PANES_IMPL, teamWorkingIn } from "../../domain/deck";
import type { Cmd } from "../../ipc/generated/lifecycle/Cmd";
import type { Outcome } from "../../ipc/generated/lifecycle/Outcome";
import type { Intent } from "../../ipc/generated/lifecycle/Intent";
import { createDeckActions } from "../deckActions";
import { createDeckCommands } from "../lifecycle/deckCommands";
import type { LeaseAsk } from "../../ipc/generated/lifecycle/LeaseAsk";
import type { PanePhase } from "../../ipc/generated/lifecycle/PanePhase";
import type { Reply } from "../../ipc/generated/lifecycle/Reply";
import type { Snapshot } from "../../ipc/generated/lifecycle/Snapshot";
// From the module, not the barrel: the barrel is mocked below, and these are
// plain shapes and pure predicates with no cache state to fake.
import {
  EMPTY_SPAWN_CONTEXT,
  resumeDiedSilently as realResumeDiedSilently,
} from "../spawnSpecs/plans";
import { createWorkspaceInstance as createWorkspaceInstanceImpl } from "../../domain/workspaceInstance";
import type { SessionHandle } from "../../domain/journal";
import {
  buildForkSpec as buildForkSpecImpl,
  buildResumeSpec as buildResumeSpecImpl,
  clearPanePlanError as clearPanePlanErrorImpl,
  dropPaneSpawnSpec as dropPaneSpawnSpecImpl,
  peekPaneSpawnSpec as peekPaneSpawnSpecImpl,
} from "../spawnSpecs";
import type { Deck } from "../useDeck";
import { useDeck } from "../useDeck";
import { createDeckStore } from "../deckStore";
import { createAgentOrchestrator, type AgentOrchestrator, type AgentRunView } from ".";
import { useAgentRunView } from "../useAgentRunView";
import type { SpawnPluginAccess } from "../spawnSpecs";
import { createSpawnPluginsFake } from "../spawnSpecs/planTestSupport";
import { createPtyManager, type OpenSession, type PtyManager } from "../ptyManager";
import { createSessionDoor, exitEvent, type Spawn } from "../ptyManager.testSupport";

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
interface CachedSpec {
  command?: string;
  args: string[];
  env: [string, string][];
  resumeOf?: string;
  resumeOrigin?: string;
  resumeRetry?: boolean;
  postbackMark?: number;
}
const plans = vi.hoisted(() => ({
  specs: new Map<string, CachedSpec>(),
  /** Panes whose last plan build failed — the error tile's source. */
  failed: new Set<string>(),
  /** Set by the mock factory; a test that seeds the cache by hand calls it. */
  notify: (() => {}) as () => void,
  /** Set by the mock factory: clears the fake cache AND its listeners, which
   * only the factory can reach. Re-exported below as the harness's reset. */
  reset: (() => {}) as () => void,
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
        // A build that failed leaves no plan, as the real one does.
        if (pane.idle || specs.has(pane.id) || plans.failed.has(pane.id)) return false;
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
    // The REAL predicate, not a copy of it. It is pure and holds no module
    // state, so there is nothing to fake — and a hand-copied one meant these
    // suites went on asserting that auto-recovery is wired to a rule the
    // production code had since changed.
    resumeDiedSilently: realResumeDiedSilently,
    buildResumeSpec: vi.fn(
      async (
        _plugins: unknown,
        _agentType: string,
        facts: { paneId: string },
        _ctx: unknown,
        resumeId: string,
        origin: "restore" | "manual",
        retry = false,
      ) => {
        if (gate.build) await gate.build;
        specs.set(facts.paneId, {
          args: ["--resume", resumeId],
          env: [],
          resumeOf: resumeId,
          resumeOrigin: origin,
          ...(retry ? { resumeRetry: true } : {}),
          postbackMark: 0,
        });
        notify();
        return true;
      },
    ),
    // The plugin's store surgery, in miniature: it caches a plan for the pane
    // and answers what it declared. What the surgery DOES is the plugin's test.
    buildForkSpec: vi.fn(async (_p: unknown, _a: string, facts: { paneId: string }) => {
      specs.set(facts.paneId, { args: [], env: [] });
      notify();
      return { plugin: "p", onceStarted: [], ifNeverStarted: [] };
    }),
    peekPaneSpawnSpec: (id: string) => specs.get(id),
    // A refused manual wake drops the half-built plan, or the pane's next
    // wake lands on the plan-error tile instead of a terminal.
    dropPaneSpawnSpec: vi.fn((id: string) => {
      const had = specs.delete(id);
      notify();
      return had;
    }),
    markPaneResumeOrigin: vi.fn((id: string, origin: string) => {
      const spec = specs.get(id);
      if (spec) specs.set(id, { ...spec, resumeOrigin: origin });
      notify();
    }),
    resetPaneSpawnSpecs: (plans.reset = () => {
      specs.clear();
      plans.failed.clear();
      // The orchestrator under test subscribes on construction; a listener
      // from a previous mount would keep reconciling its own dead deck.
      listeners.clear();
    }),
  };
});
/** Record the deferred staged-skill question carried by spawn facts. */
const skillsAsked = vi.fn((_workspace: { id: string; instance: string }) =>
  Promise.resolve(null),
);
vi.mock("../postbacks", () => ({ postbackCount: () => 0 }));

// The live-registry seam, faked with the same contract as the real one:
// tests set the ANSWER, the wiring decides with it. `null` (the default) is
// "no capability to ask" — the legacy behavior — which is what a suite that
// never touches this sees.
export const liveRegistry = {
  answer: null as "live" | "absent" | "unknown" | null,
};
vi.mock("../liveSessions", () => ({
  askLiveRegistry: vi.fn(async () => liveRegistry.answer),
  liveOutsideSessions: vi.fn(async () => ({ ok: false })),
}));

/** A retired session's per-process state must not stay bound to the pane, or
 *  a suspended card keeps showing the dead conversation's ctx% and cost and a
 *  restarted pane accumulates on top of the old baseline. One owner call per
 *  site (usage, activity and the pane's bound session retire together — the
 *  set diverging is how a /clear once kept the dead conversation's badge). A
 *  fake handed in through the orchestrator's lifecycle port — not a module
 *  mock — so these tests never touch the app's live stores. */
const lifecycle = { retire: vi.fn() };
/** The session index's transcript answer, keyed "agent:sessionId" — what a
 *  fork falls back to when the journal never learned the path. */
const transcripts = {
  indexed: new Map<string, string>(),
  locateTranscript: vi.fn(
    async (agent: string, sessionId: string) =>
      transcripts.indexed.get(`${agent}:${sessionId}`) ?? null,
  ),
};
/**
 * The lifecycle machine as the orchestrator reaches it, faked: every intent
 * is recorded and answered as `answer` says (accepted by default, naming
 * the ids it would make); every lease is granted a fresh permit unless a
 * test refuses it; the snapshot is open — the barrier down — with the pane
 * phases a test sets.
 */
export const machine = {
  intents: [] as Intent[],
  leases: [] as LeaseAsk[],
  released: [] as number[],
  hookEnded: vi.fn(),
  op: 0,
  permit: 0,
  /** What the next intents are answered; null answers every one accepted. */
  answer: null as Reply | null,
  /** What the next leases are answered; null grants each a permit. */
  leaseAnswer: null as Reply | null,
  open: true,
  phases: {} as Record<string, PanePhase>,
  listeners: new Set<() => void>(),
  snapshot(): Snapshot {
    return {
      open: machine.open,
      viewOnly: false,
      sessionsDown: false,
      forgotten: { workspaces: [], teams: [], panes: [] },
      workspaces: {},
      teams: {},
      gates: {},
      panes: machine.phases,
      commands: [],
    };
  },
  /** The machine's state moved: the snapshot listeners hear it. */
  publish() {
    for (const listener of [...machine.listeners]) listener();
  },
  /** The deck owner and the run-state owner the fake carries its commands
   * through — the real ones, bound per mount — and the deck it reads to
   * choose a root team. */
  carry: null as ((cmd: Cmd) => Promise<Outcome>) | null,
  carryRunState: null as ((cmd: Cmd) => Promise<Outcome>) | null,
  deck: null as (() => DeckState) | null,
  async send(intent: Intent): Promise<Reply> {
    machine.intents.push(intent);
    if (machine.answer) return machine.answer;
    machine.op += 1;
    const accepted: Reply = { kind: "answered", answer: { kind: "accepted", op: machine.op, minted: { workspace: null, team: null, panes: [] } } };
    if (TEARDOWNS.has(intent.kind)) {
      // The real machine answers a teardown as it takes it on, and runs it
      // after: the door hears "accepted" before any process goes.
      void tearDown(intent);
      return accepted;
    }
    // What the machine asks of the deck, for the intents whose deck half is
    // one command: carried through the real deck owner, as the snapshot
    // would carry it — and a refusal of it answers the intent, as the
    // machine's op answers it.
    const cmd = deckHalfOf(intent);
    const outcome = cmd && machine.carry ? await machine.carry(cmd) : null;
    if (outcome?.kind === "rejected") {
      return { kind: "answered", answer: { kind: "refused", refusal: { kind: "rejected", why: outcome.why } } };
    }
    return accepted;
  },
  async lease(ask: LeaseAsk): Promise<Reply> {
    machine.leases.push(ask);
    if (machine.leaseAnswer) return machine.leaseAnswer;
    machine.permit += 1;
    return { kind: "answered", answer: { kind: "leased", permit: machine.permit } };
  },
  async release(permit: number): Promise<void> {
    machine.released.push(permit);
  },
  reset() {
    machine.intents = [];
    machine.leases = [];
    machine.released = [];
    machine.hookEnded.mockClear();
    machine.answer = null;
    machine.leaseAnswer = null;
    machine.open = true;
    machine.phases = {};
    machine.listeners.clear();
  },
};

/** The intents the machine runs as a teardown: it stops their panes. */
const TEARDOWNS: ReadonlySet<Intent["kind"]> = new Set(["suspend", "restart", "closeAgent", "disband", "closeWorkspace", "archive"]);

/**
 * A teardown, as the real one runs once it took it on: each pane's plan is
 * retired before its process goes; the processes are stopped by their exact
 * session, and the page's registry hears each end; the deck half lands; and
 * once the sessions are over, the launch lets go of each pane's slot — in
 * place for a restart, whose pane stays.
 */
async function tearDown(intent: Intent): Promise<void> {
  const stopped = stoppedBy(intent);
  const runState = async (cmd: Cmd) => {
    if (machine.carryRunState) await machine.carryRunState(cmd);
  };
  for (const pane of stopped) await runState({ kind: "retire", workspace: intent.workspace, pane });
  for (const pane of stopped) pty.stop(pane);
  // The page hears the ends before the machine lets go of the slots: in
  // between, the funnel sees each stopped slot still taken.
  await Promise.resolve();
  const cmd = deckHalfOf(intent);
  if (cmd && machine.carry) await machine.carry(cmd);
  for (const pane of stopped) {
    await runState({ kind: "release", workspace: intent.workspace, pane, inPlace: intent.kind === "restart" });
  }
}

/** The panes whose process the machine stops for an intent, as the real one
 * does: one pane's suspend, restart and close; a team's members on a
 * disband; every pane of a workspace closed or archived. */
function stoppedBy(intent: Intent): string[] {
  const ws = machine.deck?.().workspaces.find((candidate) => candidate.id === intent.workspace);
  if (!ws) return [];
  switch (intent.kind) {
    case "suspend":
    case "restart":
    case "closeAgent":
      return [intent.pane];
    case "disband":
      return ws.panes.filter((pane) => pane.team?.teamId === intent.team).map((pane) => pane.id);
    case "closeWorkspace":
    case "archive":
      return ws.panes.map((pane) => pane.id);
    default:
      return [];
  }
}

/** The deck half of an intent, as the machine sends it: the marker of a
 * suspend or a resume, of an archive or a restore; an agent's close taking
 * its pane off; and a relocate's move — onto the team already on the
 * workspace root, or one made under the intent's root id. */
function deckHalfOf(intent: Intent): Cmd | null {
  switch (intent.kind) {
    case "resume":
      return { kind: "clearSuspended", workspace: intent.workspace, pane: intent.pane };
    case "suspend":
      return { kind: "markSuspended", workspace: intent.workspace, pane: intent.pane };
    case "closeAgent":
      return { kind: "removePane", workspace: intent.workspace, pane: intent.pane };
    case "archive":
      return { kind: "markArchived", workspace: intent.workspace };
    case "restore":
      return { kind: "clearArchived", workspace: intent.workspace };
    case "relocate": {
      const ws = machine.deck?.().workspaces.find((candidate) => candidate.id === intent.workspace);
      const root = ws ? teamWorkingIn(ws, ws.cwd) : undefined;
      return { kind: "movePane", workspace: intent.workspace, pane: intent.pane, to: root?.id ?? intent.root, newRoot: !root, role: intent.role };
    }
    default:
      return null;
  }
}

export const ipcHarness = ipc;
export const gateHarness = gate;
export const plansHarness = plans;
export const lifecycleHarness = lifecycle;
export const skillsAskedHarness = skillsAsked;
export const transcriptsHarness = transcripts;
export {
  transcriptsHarness as transcripts,
  gateHarness as gate,
  ipcHarness as ipc,
  plansHarness as plans,
  skillsAskedHarness as skillsAsked,
  lifecycleHarness as lifecycle,
};
export const buildForkSpec = buildForkSpecImpl;
export const buildResumeSpec = buildResumeSpecImpl;
export const clearPanePlanError = clearPanePlanErrorImpl;
export const dropPaneSpawnSpec = dropPaneSpawnSpecImpl;
export const peekPaneSpawnSpec = peekPaneSpawnSpecImpl;
// The FAKE cache's reset, not the real one: `../spawnSpecs` is mocked here, so
// the real module's state is not what these suites hold. (The barrel does not
// carry the real one either — it is test-only, and belongs to `./cache`.)
export const resetPaneSpawnSpecs = () => plans.reset();
export const MAX_PANES = MAX_PANES_IMPL;
export const createWorkspaceInstance = createWorkspaceInstanceImpl;
export const emptyJournal = emptyJournalImpl;

/** The REAL session registry, over a door to the sessions machine that starts
 *  every process it is asked for at once. Built afresh by each `reset`, so the
 *  orchestrator a test mounts runs on its own registry. A copy of the
 *  registry's rules stood here before; with two states where the real one has
 *  five, it hid that a stop which moved out of the page left every stopped
 *  pane's slot taken. */
function startingDoor() {
  const door = createSessionDoor();
  /** Spawns not answered yet: a test holding starts sees them starting. */
  const pending = new Set<Spawn>();
  const open: OpenSession = (opts, permit, owner, onEvent) => {
    const started = door.open(opts, permit, owner, onEvent);
    const spawn = door.spawns[door.spawns.length - 1];
    if (pty.holdStarts) pending.add(spawn);
    else spawn.resolve(door.makeSession());
    return started;
  };
  return { door, pending, registry: createPtyManager(open) };
}

/** The pane's latest process, as the door started it. */
function latestSpawn(paneId: string): Spawn | undefined {
  const own = sessions.door.spawns.filter((candidate) => paneOf(candidate) === paneId);
  return own[own.length - 1];
}

let sessions = startingDoor();

export const pty = {
  /** The registry the orchestrator a test mounts is handed. */
  get registry(): PtyManager {
    return sessions.registry;
  },
  /** Every process the orchestrator started, in order, with the WHOLE spec,
   *  args and env included. Recording only the pane id left the step the
   *  orchestrator absorbed from TerminalPane unguarded: nothing proved a
   *  resume plan's `--resume <id>` reached the spawned process. */
  get acquired() {
    return sessions.door.spawns.map((spawn) => ({
      paneId: paneOf(spawn),
      command: spawn.opts.command,
      cwd: spawn.opts.cwd,
      args: spawn.opts.args,
      env: spawn.opts.env,
      /** The lease the spawn spent. */
      launch: { permit: spawn.permit, owner: spawn.owner },
    }));
  },
  /** Starts are left starting until a test lets them through, or a stop
   *  cancels them. */
  holdStarts: false,
  /** Panes whose next stop is never confirmed: the process did not exit
   *  within the stop's bound, and no exit is ever reported. */
  unconfirmed: new Set<string>(),
  /** The pane's process ends by itself, as the sessions machine reports it. */
  exit(paneId: string, code: number | null = 0) {
    latestSpawn(paneId)?.onEvent(exitEvent(code));
  },
  /** The machine stops the pane's process by its exact session, as the
   *  sessions machine carries it out: a start still in flight is cancelled at
   *  the start boundary — its spawn refused, no process, no exit to come — a
   *  running process ends, and one whose end is not confirmed says nothing. */
  stop(paneId: string) {
    const spawn = latestSpawn(paneId);
    if (!spawn || pty.unconfirmed.has(paneId)) return;
    if (sessions.pending.delete(spawn)) spawn.reject(new Error("the launch was cancelled at the start boundary"));
    else spawn.onEvent(exitEvent(143));
  },
  state(paneId: string) {
    return sessions.registry.state(paneId);
  },
  /** Whether the pane's process is running now. */
  isLive(paneId: string) {
    return sessions.registry.state(paneId).kind === "live";
  },
  reset() {
    pty.holdStarts = false;
    pty.unconfirmed.clear();
    sessions = startingDoor();
    // The machine the processes are leased from goes with them: every suite
    // resets the pty per test, and a lease or an intent of the last test must
    // not answer this one.
    machine.reset();
  },
};

/** The pane a process was started for: the owner its lease names. */
function paneOf(spawn: Spawn): string | null {
  return spawn.owner.kind === "pane" || spawn.owner.kind === "remote" ? spawn.owner.pane : null;
}

export let deck: Deck;
export let agentRun: AgentRunView &
  Pick<
    AgentOrchestrator,
    | "reachOf"
    | "resume"
    | "resumeTeam"
    | "teamActs"
    | "startFresh"
    | "createPane"
    | "createTeam"
    | "createWorkspace"
    | "retryProvisioning"
    | "resumeSession"
    | "forkSession"
    | "suspend"
    | "suspendTeam"
    | "restart"
    | "recoverRejectedResume"
    | "retryPlanBuild"
    | "close"
    | "runState"
    | "archive"
    | "restore"
    | "dismissOccupied"
  >;
export const ctx = { ...EMPTY_SPAWN_CONTEXT, bridgeDir: "/bridge/run-1" };

// What the orchestrator's gate consults — swappable per test. The id set is
// open (a pane whose agent no plugin provides must be skipped), and the launch
// policy is read live, so a test may flip it while the deck stands.
export const catalog = {
  parkOnLaunch: false,
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
    const owner = createDeckCommands(store, createDeckActions(store));
    machine.carry = (cmd) => owner.carry({ id: { op: machine.op, index: 0 }, owner: "deck", cmd });
    machine.deck = store.getSnapshot;
    return {
      store,
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
        sessions: pty.registry,
        // The registry seam recovery asks (live sessions): an empty agent
        // registry answers "no capability" — the legacy behavior.
        plugins: createSpawnPluginsFake().plugins,
        probe: ipc.probeWorktree,
        mcpAccess: async () => ({ entries: [] }),
        armCwd: async () => {},
        lifecycle,
        transcripts,
        skills: { skillsFor: skillsAsked },
        bindings: { subscribe: () => () => {} },
        machine: {
          send: machine.send,
          lease: machine.lease,
          release: machine.release,
          snapshot: machine.snapshot,
          subscribe(listener: () => void) {
            machine.listeners.add(listener);
            return () => machine.listeners.delete(listener);
          },
          hookEnded: machine.hookEnded,
        },
      }),
    };
  });
  deck = useDeck(wiring.store);
  machine.carryRunState = (cmd) => wiring.orchestrator.runState.runState.carry({ id: { op: machine.op, index: 0 }, owner: "runState", cmd });
  agentRun = {
    ...useAgentRunView(wiring.orchestrator),
    reachOf: wiring.orchestrator.reachOf,
    resume: wiring.orchestrator.resume,
    resumeTeam: wiring.orchestrator.resumeTeam,
    teamActs: wiring.orchestrator.teamActs,
    startFresh: wiring.orchestrator.startFresh,
    createPane: wiring.orchestrator.createPane,
    createTeam: wiring.orchestrator.createTeam,
    createWorkspace: wiring.orchestrator.createWorkspace,
    retryProvisioning: wiring.orchestrator.retryProvisioning,
    resumeSession: wiring.orchestrator.resumeSession,
    forkSession: wiring.orchestrator.forkSession,
    suspend: wiring.orchestrator.suspend,
    suspendTeam: wiring.orchestrator.suspendTeam,
    restart: wiring.orchestrator.restart,
    archive: wiring.orchestrator.archive,
    restore: wiring.orchestrator.restore,
    recoverRejectedResume: wiring.orchestrator.recoverRejectedResume,
    retryPlanBuild: wiring.orchestrator.retryPlanBuild,
    close: wiring.orchestrator.close,
    runState: wiring.orchestrator.runState,
    dismissOccupied: wiring.orchestrator.dismissOccupied,
  };
  return null;
}

/** A deck with one idle (restored) claude pane; `pane` overrides fields.
 * Given `location`, the pane is on a team placed there — a directory is
 * the team's, never the pane's own. */
export const restored = (pane: object, location?: TeamLocation): DeckState => ({
  workspaces: [
    {
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      ...(location && { teams: [{ id: "team-1", name: "one", location }] }),
      panes: [
        {
          id: "pane-1",
          agentType: "claude",
          idle: { reason: "waking", origin: "restore" },
          ...(location && { team: { teamId: "team-1", role: "lead" } }),
          ...pane,
        },
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


export type { DeckState, Pane, PaneIdle, SessionHandle, SpawnConfig, SpawnPluginAccess };
