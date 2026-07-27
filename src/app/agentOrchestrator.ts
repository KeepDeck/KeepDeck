import type { AgentRestartMode, ResumeOrigin } from "../domain/agents";
import {
  findPane,
  findWorkspace,
  findWorkspaceByRef,
  MAX_PANES,
  paneAgentType,
  paneExecutionCwd,
  paneId,
  paneIsRemoteFresh,
  paneResumeSessionId,
  paneRunIntent,
  paneSuspendBlock,
  paneWakeOrigin,
  sessionClaimant,
  skillRootsOf,
  WORKSPACE_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
  type Pane,
  type SpawnConfig,
  type Workspace,
  type WorktreeTarget,
} from "../domain/deck";
import type { SessionHandle } from "../domain/journal";
import {
  createWorkspaceInstance,
  type WorkspaceRef,
} from "../domain/workspaceInstance";
import { describeError, log } from "../ipc/log";
import { mintAgentSeqs } from "./ids";
import { clearPaneUsage } from "./usageManager";
import { postbackCount } from "./postbacks";
import type { SuspendOutcome } from "./suspendOutcome";
import {
  clearPostProvision,
  discardWorktreeOnArrival,
  planPanes,
  provisionInto,
  registerPostProvision,
  setupStepFor,
  type ProvisionCallbacks,
  type SetupStep,
} from "./provisioning";
import {
  createDeckActions,
  type DeckActions,
  type WorkspaceCreationResult,
} from "./deckActions";
import type { DeckStore } from "./deckStore";
import type { SpawnContextSource } from "./spawnContextSource";
import {
  buildForkSpec,
  buildLivePaneSpec,
  buildResumeSpec,
  clearPanePlanError,
  dropPaneSpawnSpec,
  resumeDiedSilently,
  markPaneResumeOrigin,
  peekPanePlanError,
  peekPaneSpawnSpec,
  subscribeSpawnSpecs,
  type SpawnPluginAccess,
} from "./spawnSpecs";
import type {
  ForkTarget,
  SpawnPlan,
  SpawnPlanContext,
} from "../domain/agents";
import type { PaneSessionState, PaneSpawnSpec } from "./ptyManager";

/**
 * The owner of an agent pane's run lifecycle.
 *
 * It answers one question for every pane — should a process be behind it,
 * and if not, why ([`paneRunIntent`]) — and drives the primitives that make
 * reality match: the worktree probe, the plugin's resume-plan hook, and the
 * deck's own transitions. Nothing here computes; the decision is the domain's
 * and the doing is the primitives'.
 *
 * Deliberately outside React. The processes it governs outlive any render,
 * and a request can arrive for a pane that is not on screen — `agent.resume`
 * takes a workspace argument precisely so it can reach one. Constructed with
 * injected ports rather than reaching for modules, so a test builds its own
 * with fakes and needs no DOM.
 */
export interface AgentOrchestrator {
  /** What the deck renders about panes that are not running. Stable between
   * changes (the `useSyncExternalStore` snapshot contract). */
  getView(): AgentRunView;
  subscribe(listener: () => void): () => void;
  /**
   * Land a new agent pane in a workspace and carry it through everything its
   * arrival implies — the capacity refusal, the worktree create behind its
   * card, the workspace's setup command when its intent calls for one. From
   * here on the run sweep takes over: nothing else has to start it.
   *
   * Every creation surface routes through this, because the checks around the
   * add are not the surface's business and were getting done differently at
   * each of them.
   */
  createPane(request: CreatePaneRequest): CreatePaneOutcome;
  /**
   * Register a whole new workspace and its agents from the create form.
   *
   * Optimistic, like every other arrival: the workspace and its panes land in
   * the deck synchronously — as provisioning cards in worktree mode — and the
   * worktree creates run behind them. So there is no busy state and nothing
   * to double-submit; the form closes on the tick that registers the panes.
   */
  createWorkspace(config: SpawnConfig): WorkspaceCreationResult;
  /** Re-issue a failed pane's worktree create from the intent its card still
   * carries. */
  retryProvisioning(wsId: string, paneId: string): void;
  /**
   * Stop a pane's agent while the pane keeps everything that makes it
   * resumable — its place in the deck, its name, its worktree, its session
   * binding. The mirror of closing, which takes all of that away.
   *
   * The one place a hold reason means "there must be NO process" rather than
   * "not yet": every other reason the run sweep produces leaves the pane
   * waiting, and this is the gesture that ends one deliberately.
   *
   * Resolves once the process is reaped, so a caller can sequence work — a
   * worktree removal — after it, and reports what happened: a caller that
   * announced success regardless would be lying to whoever asked.
   */
  suspend(wsId: string, paneId: string): Promise<SuspendOutcome>;
  /**
   * Take a pane — or a whole workspace's worth — out of the deck and end the
   * processes behind them. The mirror of suspending, which keeps everything.
   *
   * The order is the reverse of a suspend's, and deliberately so: the bridge
   * tokens are revoked BEFORE the reducer forgets the panes, so neither an
   * in-flight reporter nor a later pane reusing the id can write again.
   *
   * Resolves to the worktrees it could not delete, so the surface that asked
   * can say so. Empty when the close asked for none, or all of them went.
   */
  close(request: CloseRequest): Promise<string[]>;
  /**
   * Restart a pane's agent on the exited card's explicit action — retire the
   * process and start it again, either fresh or resuming its recorded
   * session. The pane keeps its identity, its place and its worktree; only
   * the PTY and the spawn plan are replaced.
   *
   * A `resume` restart that cannot prepare its plan REJECTS rather than
   * falling back: the user asked for that conversation by name, and quietly
   * starting a different one is the substitution this whole path guards.
   *
   * Answers what it did, like every other refusable gesture here. Four things
   * can stop a restart short of failing, and a caller that reads "resolved"
   * as "restarted" leaves its card promising a restart that is not coming.
   */
  restart(
    wsId: string,
    paneId: string,
    mode: AgentRestartMode,
  ): Promise<RestartOutcome>;
  /**
   * The one-shot recovery for a BOOT resume the CLI rejected: the process
   * exited without ever reporting a session, so there is nothing to show the
   * user and nobody watching. Respawns fresh, once.
   *
   * Returns whether this exit IS that recovery, so the caller can tell it
   * apart from a crash — a respawn in progress must not raise a notification.
   * Ordinary exits and manual resumes are ineligible and stay visible.
   */
  recoverRejectedResume(
    wsId: string,
    paneId: string,
    code: number | null,
  ): boolean;
  /** Retry a pane whose spawn PLAN failed to build — a plugin's hook threw,
   * so no process was ever started. Lighter than a restart: there is nothing
   * to retire, only a failure flag and a half-built plan to drop. */
  retryPlanBuild(paneId: string): void;
  /**
   * Continue a recorded session in a NEW pane of `wsId` ([F8]) — the journal
   * row's Resume and the "+ Agent" dialog's "Start from".
   *
   * The plan is built and cached BEFORE the pane enters the deck, so the
   * ordinary fresh-plan sweep never races it, and the pane arrives already
   * carrying `session`, which claims the record back to live in the same
   * transition. Always a MANUAL resume: a rejected id fails visibly in the
   * terminal and stays exited, because a continuation the user asked for must
   * never quietly become a different conversation.
   *
   * Rejects when no plan could be prepared, and when the session already
   * belongs to a pane — an enabled button that does nothing reads as dead.
   * `opts.name` names the pane; `opts.yolo` overrides the mode (unset =
   * inherit the recorded session's).
   */
  resumeSession(
    wsId: string,
    record: SessionHandle,
    opts?: { name?: string; yolo?: boolean },
  ): Promise<void>;
  /**
   * Copy a recorded session into a NEW pane of `wsId` ([F8]).
   *
   * The agent plugin's `fork.plan` performs its store surgery and yields the
   * spawn args; the pane then lands like any other. The surgery runs bound to
   * the directory the fork will LIVE in — which for a `dir` target exists up
   * front, but for a new worktree only AFTER the create, so it is deferred to
   * a post-provision step (opencode's `import` binds the session's directory
   * to the launch cwd, which must be the CREATED worktree). That step re-runs
   * on Retry, so a retried fork never resolves into a plain pane.
   *
   * The forked CLI reports its own NEW session id like a fresh spawn, so the
   * pane starts unbound. A deleted source directory is fine — forking is
   * exactly the escape hatch for a session whose worktree is gone.
   *
   * `opts.branch` stamps a dir-target pane's worktree branch (the spawn
   * dialog knows it, a journal row does not).
   */
  forkSession(
    wsId: string,
    record: SessionHandle,
    target: ForkTarget,
    opts?: { name?: string; branch?: string; yolo?: boolean },
  ): Promise<void>;
  /** Detach the pane from the missing worktree and start it fresh in the
   * workspace cwd. */
  startFresh(wsId: string, paneId: string): void;
  /**
   * Ask for a stopped pane back — the ONE gesture behind the card's Resume,
   * the blocked card's "Look again" and the `agent.resume` command. It clears
   * whatever the last attempt left (a block, a refusal note) and marks the
   * wake as the user's, which is what keeps a rejected session id from
   * quietly becoming a different conversation.
   *
   * Answers what it did: a live pane has nothing to resume, and a caller that
   * reports success for that would be lying.
   */
  resume(wsId: string, paneId: string): ResumeRequest;
}

export interface AgentRunView {
  /** paneId → the missing directory (the idle tile's note). */
  blocked: Record<string, string>;
  /** paneId → why the resume the USER asked for could not be prepared. The
   * pane stayed stopped rather than coming up as a different conversation;
   * its card says this. Cleared when the pane is asked for again. */
  wakeFailed: Record<string, string>;
  /** Each live pane's spawn plan, once its build lands. A pane without one
   * yet has nothing to run: its terminal waits. */
  specs: Record<string, SpawnPlan>;
  /** Panes whose plan build FAILED — the deck shows an error tile with a
   * retry instead of leaving them on "Waking up…" forever. */
  planFailed: ReadonlySet<string>;
  /** paneId → its mount generation. Bumping one remounts that pane's terminal
   * view, which is how a restart gets a fresh xterm over the new process
   * instead of the retired one's scrollback. Runtime state, published rather
   * than stored: restarting replaces a PTY and a spawn plan, not any of the
   * pane/worktree/session facts the deck persists. */
  epochs: Record<string, number>;
}

export interface CreatePaneRequest {
  /** The workspace by its exact lifetime, not its id. Every creation surface
   * decides asynchronously (a repo inspect, a worktree suggestion, a plugin's
   * fork surgery), and by the time it gets here the workspace may be closed —
   * with its `ws-N` slot already handed to a replacement that must not adopt
   * this pane. */
  workspace: WorkspaceRef;
  /** The pane as the surface shaped it, id included: the flows that build a
   * spawn plan BEFORE the pane exists key that plan by this id. */
  pane: Pane;
}

/** Whether a new pane made it into the deck. Answered rather than assumed:
 * both refusals leave the caller holding something to undo — a fork's store
 * surgery, a dialog left open — and a silent no-op is how a provisioned
 * worktree ends up on disk with no pane to own it. */
export type CreatePaneOutcome =
  | { kind: "created" }
  /** The workspace is gone (or its id now names a different one). */
  | { kind: "gone" }
  /** The workspace already holds MAX_PANES. */
  | { kind: "full" };

/** A close the user has already confirmed. The worktrees are passed in rather
 * than derived here: which of a pane's directories are candidates, and whether
 * the user ticked the box that deletes them, is what the confirm dialog was
 * FOR — by the time it reaches this, the destructive choice is settled. */
export type CloseRequest = {
  /** Empty unless the user asked for the directories to go too. */
  worktrees: WorktreeTarget[];
  /** Closing panes whose worktree create is still in flight, so they have no
   * `cwd` yet and contributed no target above. Carried separately because
   * what to delete is not known until the create settles — and a create
   * cannot be cancelled, so waiting is the only way not to strand it. Ignored
   * unless the user asked for the directories to go. */
  pendingPanes: string[];
} & (
  | { kind: "agent"; wsId: string; paneId: string }
  | { kind: "workspace"; wsId: string }
);

/** What a restart did. `restarted` means a new process is on its way; the
 * rest are reasons it stood down, none of them a failure — a failure REJECTS
 * so the card can offer to try again. */
export type RestartOutcome =
  | "restarted"
  /** A restart for this pane is already under way. */
  | "in-flight"
  /** The pane (or its workspace) is no longer in the deck. */
  | "gone"
  /** It was stopped while the restart was out — a suspend the user asked for
   * outranks a restart that started first. */
  | "stopped"
  /** It changed under the close — in practice its reporter bound a new
   * session id. The restart still completed: past the close the process is
   * already gone, so declining to mount the prepared plan would leave the
   * sweep to start a FRESH conversation instead. Reported separately from
   * `restarted` because what came back is the session the user named, not
   * necessarily the one the pane was carrying by then. */
  | "changed";

/** What asking for a pane back did. */
export type ResumeRequest =
  | "resuming"
  /** The pane is already running — nothing to bring back. */
  | "running"
  /** Its worktree is still being created; it has never run, so there is no
   * session to come back to. Distinct from "running" because telling the user
   * a pane mid-create is already running is simply false. */
  | "provisioning"
  /** No installed plugin provides this pane's agent, so the sweep would skip
   * it forever. Refused rather than marked: a pane left rising with nothing
   * to raise it loses the durable stamp that says it was stopped. */
  | "unavailable"
  /** No such pane (or workspace) in the deck. */
  | "gone";

/** The agents a plugin currently provides. Re-enabling a cli plugin must wake
 * the panes its absence kept idle, without an app restart — hence a live
 * source rather than a snapshot. */
export interface AgentCatalogPort {
  /** id → the binary that agent runs. Membership answers "does a plugin
   * provide this agent"; the value is the fallback program for a degraded
   * plan that names none. */
  commands(): ReadonlyMap<string, string>;
  /** Resolves once the plugin system has booted. Before that every pane's
   * agent would read as unknown, and waking anything would misjudge it. */
  ready(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** Does this directory still exist? The pane's worktree may have been removed
 * behind the app's back. */
export type WorktreeProbePort = (dir: string) => Promise<{ exists: boolean }>;

/** Creates the worktrees behind provisioning cards, reporting each result
 * into the deck as it lands. Injected like the probe: it shells out to git
 * and runs the workspace's setup command in a PTY, neither of which a test
 * of the creation sequence wants to actually do. Never throws — a failure
 * lands on its pane's card. */
export type ProvisionPort = (
  panes: Pane[],
  report: ProvisionCallbacks,
  setup?: SetupStep,
) => Promise<void>;

/** Tears down the git worktrees a confirmed close asked to delete, returning
 * the ones it could not. Injected for the same reason as the create beside
 * it: `git worktree remove --force` is not something a test performs. */
export type DiscardWorktreesPort = (
  targets: WorktreeTarget[],
) => Promise<string[]>;

/** Whether restored agents come back stopped instead of resuming. Live, not a
 * value captured once: the setting is not a fact about any pane, and the panes
 * it governs are precisely the ones that have not started yet — including the
 * ones still waiting in a workspace nobody has opened. */
export interface LaunchPolicyPort {
  parkOnLaunch(): boolean;
  subscribe(listener: () => void): () => void;
}

/** The live PTY sessions. Subscribed to rather than polled: a restart drops a
 * pane's cached plan and closes its process, and nothing in the deck records
 * either — without this the orchestrator would never rebuild the plan. */
export interface SessionRegistryPort {
  subscribe(listener: () => void): () => void;
  /** Whether a process already belongs to this pane — the other half of the
   * comparison the intent starts. */
  state(paneId: string): PaneSessionState;
  /** Ensure the pane runs `spec`. Idempotent per (pane, command, cwd). */
  acquire(paneId: string, spec: PaneSpawnSpec): void;
  /** End the pane's process and drop its entry. Resolves once it is reaped,
   * so a caller can sequence a worktree removal after it. */
  close(paneId: string): Promise<void>;
  /** Run a command to completion in the pane's slot, resolving to whether it
   * passed and the tail of what it printed. The workspace's one-time setup
   * command is the only user: it runs behind a provisioning card, in the slot
   * the pane's terminal takes over once the card resolves. */
  runOnce(
    paneId: string,
    spec: PaneSpawnSpec,
  ): Promise<{ ok: boolean; tail: string }>;
}

/**
 * The size a session is spawned at before its terminal has measured itself.
 * Harmless because a pane only spawns while its workspace is on screen, so a
 * mounted terminal syncs the real size through `onReady` within a frame. It
 * would NOT be harmless for a background pane, which would format a whole
 * session at the wrong width — see the unopened-workspace rule.
 */
const SPAWN_PLACEHOLDER_SIZE = { cols: 80, rows: 24 };

export interface AgentOrchestratorDeps {
  deck: DeckStore;
  spawnContext: SpawnContextSource;
  agents: AgentCatalogPort;
  launchPolicy: LaunchPolicyPort;
  sessions: SessionRegistryPort;
  plugins: SpawnPluginAccess;
  probe: WorktreeProbePort;
  provision: ProvisionPort;
  discardWorktrees: DiscardWorktreesPort;
}

/** How one attempt to bring a pane up ended. */
type Attempt =
  | { kind: "woken" }
  /** The pane's directory is gone; it needs relocating, not retrying. */
  | { kind: "blocked"; dir: string }
  /** The probe or the resume plan refused; `why` is shown on the card. */
  | { kind: "failed"; why: string };

const EMPTY_VIEW: AgentRunView = {
  blocked: {},
  wakeFailed: {},
  specs: {},
  planFailed: new Set(),
  epochs: {},
};

/** Everything a restart needs about a pane, read BEFORE the awaits. Compared
 * against the live pane afterwards: a restart that prepared a plan for one
 * conversation must not mount it over a pane that has since become another. */
interface RestartTarget {
  workspace: WorkspaceRef;
  paneId: string;
  agentType: string;
  cwd: string;
  branch: string | undefined;
  yolo: boolean | undefined;
  sessionId: string | null;
}

function sameResumeTarget(
  current: RestartTarget,
  expected: RestartTarget,
): boolean {
  return (
    current.agentType === expected.agentType &&
    current.cwd === expected.cwd &&
    current.branch === expected.branch &&
    current.sessionId === expected.sessionId
  );
}

export function createAgentOrchestrator(
  deps: AgentOrchestratorDeps,
): AgentOrchestrator {
  const {
    deck,
    spawnContext,
    agents,
    launchPolicy,
    sessions,
    plugins,
    probe,
    provision,
    discardWorktrees,
  } = deps;
  const actions: DeckActions = createDeckActions(deck);
  const blocked = new Map<string, string>();
  const wakeFailed = new Map<string, string>();
  const epochs = new Map<string, number>();
  /** Attempts in flight — a notification while one is pending must not
   * double-run it. */
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let view: AgentRunView = EMPTY_VIEW;
  let booted = false;
  let scheduled = false;

  function publish(): void {
    // The plan snapshot is read off the shared cache rather than mirrored:
    // resume and fork plans are written there by other paths, and a second
    // copy here would be a second answer to "what does this pane run".
    const specs: Record<string, SpawnPlan> = {};
    const planFailed = new Set<string>();
    for (const ws of deck.getSnapshot().workspaces) {
      for (const pane of ws.panes) {
        const spec = peekPaneSpawnSpec(pane.id);
        if (spec) specs[pane.id] = spec;
        if (peekPanePlanError(pane.id)) planFailed.add(pane.id);
      }
    }
    view = {
      blocked: Object.fromEntries(blocked),
      wakeFailed: Object.fromEntries(wakeFailed),
      specs,
      planFailed,
      epochs: Object.fromEntries(epochs),
    };
    for (const listener of [...listeners]) listener();
  }

  /** Coalesce to one pass per turn: the sweep dispatches deck transitions of
   * its own, and each would otherwise re-enter this synchronously. */
  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      reconcile();
    });
  }

  /** WHO is asking for this pane right now, or null when it is no longer
   * rising at all. Read from the LIVE deck rather than from the snapshot an
   * attempt started with: `requestPaneWake` can upgrade a boot restore to a
   * resume the user asked for by name — and a suspend can cancel the wake
   * outright — while a probe or a plan build is out. An attempt judged by the
   * stale answer is exactly how a resume becomes a different conversation. */
  function askedBy(wsId: string, paneId: string): ResumeOrigin | null {
    const pane = findPane(deck.getSnapshot().workspaces, wsId, paneId);
    return pane ? paneWakeOrigin(pane) : null;
  }

  /** Drop notes about panes that are gone (closed directly, or with their
   * workspace): ids are never reused, so the maps would only ever grow. */
  function reap(): boolean {
    const live = new Set(
      deck.getSnapshot().workspaces.flatMap((w) => w.panes.map((p) => p.id)),
    );
    let dropped = false;
    for (const map of [blocked, wakeFailed, epochs]) {
      for (const paneId of [...map.keys()]) {
        if (!live.has(paneId)) {
          map.delete(paneId);
          dropped = true;
        }
      }
    }
    for (const paneId of [...startOwed]) {
      if (!live.has(paneId)) startOwed.delete(paneId);
    }
    return dropped;
  }

  /**
   * The ONE place an attempt's outcome is turned into state. Every exit of
   * the sweep routes through here, because the rule that matters — a resume
   * the USER asked for must never come up as a different conversation — has
   * to hold for all of them, and it kept being applied to one exit at a time.
   *
   * WHO asked is re-read here rather than taken from the attempt, because the
   * answer can change while the attempt is out. A boot restore takes the
   * documented degradation on failure: nobody is watching, and an empty pane
   * beats a pane that never comes back. A manual wake goes back down where it
   * came from and says why on its card.
   */
  function settle(wsId: string, pane: Pane, attempt: Attempt): void {
    // Every exit but a successful wake gives the attempt up, so the debt goes
    // with it. Left behind, it would exempt the pane from the
    // unopened-workspace economy for the rest of the session — and a start
    // nobody is coming back for is not a start that is owed.
    if (attempt.kind !== "woken") startOwed.delete(pane.id);
    const origin = askedBy(wsId, pane.id);
    if (!origin) {
      // The pane stopped rising while this attempt was out — closed, or
      // suspended by a user who changed their mind mid-probe. Its verdict is
      // moot, and recording one would leave the card explaining a failure
      // nobody is waiting on (or block a pane nobody asked to wake).
      log.info(
        "web:orchestrator",
        `${pane.id}: wake outcome dropped — the pane is no longer rising`,
      );
      startOwed.delete(pane.id);
      return;
    }
    if (attempt.kind === "woken") {
      actions.clearPaneIdle(wsId, pane.id);
      return;
    }
    if (attempt.kind === "blocked") {
      log.warn(
        "web:orchestrator",
        `${pane.id}: directory gone ${attempt.dir} → blocked tile`,
      );
      blocked.set(pane.id, attempt.dir);
      publish();
    } else {
      log.warn(
        "web:orchestrator",
        `${pane.id}: ${origin} wake failed — ${attempt.why}`,
      );
    }
    if (origin !== "manual") {
      // Nothing to put back: a restore-origin pane that is blocked simply
      // stays where the sweep left it, and one that failed wakes fresh.
      if (attempt.kind === "failed") {
        // Fresh means fresh: a build that THREW also left the pane marked
        // plan-failed inside the spec cache, and waking it with that flag
        // still set lands it on the plan-error tile instead of a terminal.
        dropPaneSpawnSpec(pane.id);
        actions.clearPaneIdle(wsId, pane.id);
      }
      return;
    }
    if (attempt.kind === "failed") {
      wakeFailed.set(pane.id, attempt.why);
      publish();
    }
    // Drop the half-built plan with its failure flag, or the pane's next
    // wake lands on the plan-error tile instead of a terminal.
    dropPaneSpawnSpec(pane.id);
    actions.failPaneWake(wsId, pane.id);
  }

  /**
   * Start the worktree creates behind panes that arrived as cards. Panes
   * without an intent are ignored, so a caller may pass a whole workspace's
   * worth or a single retry.
   *
   * The workspace's one-time setup command runs only for a pane whose intent
   * says the create form's batch stamped it. A "+ Agent", fork or command
   * pane joins a workspace that was prepared once already, and re-running the
   * preparation per pane is not what "one-time" means. The same reading gives
   * a Retry its rule for free: it consults the stamp, so it can never have
   * wider effects than the attempt it retries.
   *
   * Split by that stamp rather than reading the first pane's answer for the
   * whole batch — one of the two groups is always empty in practice, and a
   * rule that happens to hold is not a rule.
   */
  function provisionPanes(ws: Workspace, panes: Pane[]): void {
    const cards = panes.filter((pane) => pane.provisioning);
    const stamped = cards.filter((pane) => pane.provisioning?.runsSetup);
    const plain = cards.filter((pane) => !pane.provisioning?.runsSetup);
    if (stamped.length > 0) {
      // The setup command occupies the pane's own process slot, so it is
      // handed over as a step bound to the registry — the same owner every
      // other process behind a pane goes through.
      const step = ws.setup
        ? setupStepFor(ws.setup, sessions.runOnce)
        : undefined;
      void provision(stamped, provisionInto(actions, ws.id), step);
    }
    if (plain.length > 0) void provision(plain, provisionInto(actions, ws.id));
  }

  /** See [`AgentOrchestrator.createPane`]. A named function rather than an
   * object member because the continuation flows below land their panes
   * through it too. */
  function landPane({ workspace, pane }: CreatePaneRequest): CreatePaneOutcome {
    const ws = findWorkspaceByRef(deck.getSnapshot().workspaces, workspace);
    const refuse = (kind: "gone" | "full"): CreatePaneOutcome => {
      // Everything a caller cached under this id, dropped together: there is
      // no pane to run the plan or to finish the fork's surgery, and ids are
      // never reused, so both would sit there for the life of the process.
      dropPaneSpawnSpec(pane.id);
      clearPostProvision(pane.id);
      return { kind };
    };
    if (!ws) return refuse("gone");
    if (ws.panes.length >= MAX_PANES) return refuse("full");
    actions.addAgentPane(ws.id, pane);
    provisionPanes(ws, [pane]);
    return { kind: "created" };
  }

  /**
   * Land a pane for a continuation, turning either refusal into a throw.
   *
   * The continuations differ from `createPane` in the one way that matters
   * here: by the time they land, they have already done work that cannot be
   * taken back — a fork's export→rekey→import into the agent's own session
   * store. `full` was thrown and `gone` was not, so a workspace closed inside
   * that await resolved the promise as if it had worked, leaving a cloned
   * session in the store with no pane, no error and a dialog that closed on
   * success. An exhaustive switch, so a fourth outcome cannot be added
   * silently.
   */
  function landOrThrow(landed: CreatePaneOutcome): void {
    switch (landed.kind) {
      case "created":
        return;
      case "full":
        throw new Error(WORKSPACE_FULL_MESSAGE);
      case "gone":
        throw new Error(WORKSPACE_GONE_MESSAGE);
    }
  }

  /**
   * Sessions with a continuation already under way, by recorded session id —
   * a double-click guard. Resuming the same session twice is one gesture
   * repeated; forking it twice is two legitimate forks racing.
   *
   * Two sets, not one. The gestures are not alternatives to each other: a
   * fork COPIES a session and a resume CLAIMS it, so a fork's store surgery —
   * seconds of export/rekey/import — must not silently swallow the Resume
   * next to it, leaving a dead button and no error.
   */
  const resuming = new Set<string>();
  const forking = new Set<string>();

  /**
   * Panes owed a process that has not arrived yet — see [`PaneRunEnv`]'s
   * `startOwed`. Every gesture that asks for a pane by name, and every one
   * that retires a process on the promise of another, records the debt here.
   *
   * Held here rather than on the pane because it is not a fact about the
   * pane: it is a fact about an operation in flight. It stops being true when
   * the pane has a process, when the attempt gives up, or when the pane goes.
   */
  const startOwed = new Set<string>();

  /** Panes whose process is being reaped. Distinct from `inFlight`, which
   * tracks panes on their way UP: the two gestures can be asked for in either
   * order, and one must not read as the other's guard. */
  const suspending = new Set<string>();

  /** Panes being restarted. Deliberately NOT shared with `suspending`: a
   * suspend may land inside a restart's awaits, and the restart's job then is
   * to notice and stand down — which it cannot do if the suspend was blocked
   * from happening at all. */
  const restarting = new Set<string>();

  /** Remount the pane's terminal view over its new process. */
  function bumpEpoch(paneId: string): void {
    epochs.set(paneId, (epochs.get(paneId) ?? 0) + 1);
    publish();
  }

  /** Everything a restart needs about `paneId`, or null when it is gone. */
  function restartTargetOf(
    workspaceRef: string | WorkspaceRef,
    paneId: string,
  ): RestartTarget | null {
    const workspaces = deck.getSnapshot().workspaces;
    const ws =
      typeof workspaceRef === "string"
        ? findWorkspace(workspaces, workspaceRef)
        : findWorkspaceByRef(workspaces, workspaceRef);
    const pane = ws?.panes.find((candidate) => candidate.id === paneId);
    if (!ws || !pane) return null;
    return {
      workspace: { id: ws.id, instance: ws.instance },
      paneId,
      agentType: paneAgentType(pane),
      cwd: pane.cwd ?? ws.cwd,
      branch: pane.branch,
      yolo: pane.yolo,
      sessionId: paneResumeSessionId(pane),
    };
  }

  /** Is the pane stopped right now? A suspend can land inside a restart's
   * awaits, and it leaves every field `sameResumeTarget` compares untouched —
   * only the idle marker says so. Standing down there is what keeps the
   * user's suspend from being undone by a restart that started first. */
  function stoppedNow(target: RestartTarget): boolean {
    return !!findPane(
      deck.getSnapshot().workspaces,
      target.workspace.id,
      target.paneId,
    )?.idle;
  }

  async function restartFresh(target: RestartTarget): Promise<RestartOutcome> {
    // Invalidate the old bridge token before anything can report late from
    // the retired process. The next plan build is triggered by the epoch.
    dropPaneSpawnSpec(target.paneId);
    clearPaneUsage(target.paneId);
    await sessions.close(target.paneId);
    if (!restartTargetOf(target.workspace, target.paneId)) return "gone";
    // The pane is parked now, and its binding is exactly what its resume
    // needs: dropping it here would turn the user's suspend into a fresh
    // conversation.
    if (stoppedNow(target)) return "stopped";
    // Fresh means fresh on the next app launch too. Keep cwd/branch/worktree;
    // only the exact session binding is replaced by the new reporter later.
    actions.setPaneSession(target.workspace.id, target.paneId, null);
    bumpEpoch(target.paneId);
    return "restarted";
  }

  async function restartResume(target: RestartTarget): Promise<RestartOutcome> {
    const ctx = spawnContext.get();
    if (!ctx) throw new Error("Agent spawn context is unavailable");
    if (!target.sessionId) return restartFresh(target);

    // The spec is deliberately NOT dropped before the build. Every stand-down
    // between here and `sessions.close` leaves the pane's process RUNNING, and
    // dropping revokes the token that process's reporters echo: the next plan
    // mints a fresh one, so every postback it sends afterwards fails
    // verification, silently, for the life of the process (see the token's own
    // note in spawnSpecs). Building over the entry is safe instead — a
    // successful build replaces it, and a failed one leaves it exactly as the
    // running process needs it.
    const ws = findWorkspaceByRef(
      deck.getSnapshot().workspaces,
      target.workspace,
    );
    let planBuilt: boolean;
    try {
      planBuilt = await buildResumeSpec(
        plugins,
        target.agentType,
        {
          paneId: target.paneId,
          workspace: target.workspace,
          cwd: target.cwd,
          branch: target.branch,
          yolo: target.yolo,
          ...(ws ? { wsSkillRoots: skillRootsOf(ws) } : {}),
        },
        ctx,
        target.sessionId,
        "manual",
      );
    } catch (error) {
      // A `resume.plan` hook that THREW marked the pane plan-failed in the
      // cache. Its process is still running, so leaving that flag set paints
      // the error tile over a live terminal — the card must report a restart
      // that failed, not replace the agent the user is still talking to.
      clearPanePlanError(target.paneId);
      throw error;
    }

    const current = restartTargetOf(target.workspace, target.paneId);
    if (!current) {
      dropPaneSpawnSpec(target.paneId);
      return "gone";
    }
    // Asked BEFORE the plan is judged: a suspend landing inside the build
    // invalidates it by design (it drops the spec, which retires this build's
    // generation), so reading that as "the agent could not prepare a plan"
    // blamed the agent for the user's own gesture — and said so on the card of
    // a pane that had just been parked on purpose.
    if (stoppedNow(target)) return "stopped";
    if (!sameResumeTarget(current, target)) {
      throw new Error("Agent changed while its restart was being prepared");
    }
    const spec = peekPaneSpawnSpec(target.paneId);
    if (
      !planBuilt ||
      spec?.resumeOrigin !== "manual" ||
      spec.resumeOf !== target.sessionId
    ) {
      // A missing agent or a failed resume hook must not silently degrade a
      // user-requested continuation into a fresh conversation.
      throw new Error("Agent could not prepare a resume plan");
    }

    clearPaneUsage(target.paneId);
    await sessions.close(target.paneId);
    const afterClose = restartTargetOf(target.workspace, target.paneId);
    if (!afterClose) {
      dropPaneSpawnSpec(target.paneId);
      return "gone";
    }
    if (stoppedNow(target)) {
      // Idle now, so the sweep holds it — and a manual resume plan left in the
      // cache would mislead whatever wakes it next.
      dropPaneSpawnSpec(target.paneId);
      return "stopped";
    }
    // Past the close, "stand down and do nothing" is no longer on offer: the
    // process is already retired, so the sweep sees a pane that should run
    // with none — and with the plan dropped it would build a FRESH one,
    // turning the resume the user named into a brand-new conversation whose
    // reporter then overwrites the binding. Mounting the plan that WAS
    // prepared is the only honest option left, so the epoch is bumped either
    // way; the outcome only tells the caller what the pane looked like when
    // the close returned.
    bumpEpoch(target.paneId);
    return sameResumeTarget(afterClose, target) ? "restarted" : "changed";
  }

  /** Wake one pane onto `sessionId`, or fresh when it is null. */
  async function wake(
    ws: Workspace,
    pane: Pane,
    dir: string,
    sessionId: string | null,
  ): Promise<void> {
    const agentType = paneAgentType(pane);
    // WHOSE resume this is decides what happens when the CLI rejects the id.
    // A boot restore takes the one-shot fall back to a fresh conversation —
    // nobody is watching, and an empty pane beats a dead one. A resume the
    // user CLICKED must not: they were promised this session by name, so a
    // rejection has to stay visible as an exited pane they can act on.
    let origin = askedBy(ws.id, pane.id);
    // Cancelled while the probe was out (suspended, or closed outright):
    // there is nothing to bring up and nobody to report to.
    if (!origin) return;
    log.info(
      "web:orchestrator",
      `${pane.id} (${agentType}): ` +
        (sessionId ? `${origin} resume ${sessionId}` : "fresh"),
    );
    const ctx = spawnContext.get();
    if (sessionId && ctx) {
      // Built through the agent plugin's resume.plan hook and cached BEFORE
      // the pane wakes — the mounting terminal reads it.
      const plan = (asked: ResumeOrigin) =>
        buildResumeSpec(
          plugins,
          agentType,
          {
            paneId: pane.id,
            workspace: { id: ws.id, instance: ws.instance },
            cwd: dir,
            branch: pane.branch,
            yolo: pane.yolo,
            wsSkillRoots: skillRootsOf(ws),
          },
          ctx,
          sessionId,
          asked,
        );
      let failure: string | null = null;
      try {
        const built = await plan(origin);
        // The upgrade can also land INSIDE the build, and the origin is BAKED
        // INTO the cached plan — it is what arms (or disarms) the one-shot
        // fall back to a fresh conversation. A plan built as a restore
        // therefore cannot serve a resume the user asked for by name.
        // Re-stamped rather than rebuilt: the origin never reaches the agent's
        // hook, so there is nothing for a second build to produce differently,
        // and a plugin hook is someone else's code to run twice.
        const nowAsked = askedBy(ws.id, pane.id);
        if (built && nowAsked === "manual" && origin !== "manual") {
          log.info(
            "web:orchestrator",
            `${pane.id}: asked for by name mid-build → re-stamped as a manual resume`,
          );
          origin = "manual";
          markPaneResumeOrigin(pane.id, "manual");
        }
        // A `false` here is "no plan was cached", and it covers two very
        // different causes: a plugin that offers no resume.plan hook at all,
        // and a build a newer decision invalidated mid-flight. The sentence
        // names neither, because this layer cannot tell them apart — blaming
        // the agent for the second one was simply false.
        //
        // Either way the pane must not wake: the ordinary fresh sweep would
        // start a NEW conversation whose reporter then overwrites the binding,
        // the silent substitution the `manual` origin prevents.
        if (!built) failure = "Its resume plan could not be prepared.";
      } catch (e) {
        failure = describeError(e);
      }
      if (failure) {
        settle(ws.id, pane, { kind: "failed", why: failure });
        return;
      }
    }
    settle(ws.id, pane, { kind: "woken" });
  }

  /** Every live pane needs a plan before its terminal has anything to run.
   * Kept next to the wake pass because they are the same reconciliation seen
   * from two sides — one decides that a pane should run, the other prepares
   * what running means — and splitting them across two owners is how a pane
   * came to be woken with no plan cached for it. */
  function planLivePanes(ctx: SpawnPlanContext): void {
    for (const ws of deck.getSnapshot().workspaces) {
      for (const pane of ws.panes) {
        void buildLivePaneSpec(plugins, ws, pane, ctx).then((changed) => {
          if (!changed) return;
          publish();
          // A plan landing is what a pane waiting to start was waiting FOR —
          // reconcile again, or nothing spawns until an unrelated notification
          // happens along.
          schedule();
        });
      }
    }
  }

  function reconcile(): void {
    if (reap()) publish();
    // Wait for the spawn context (a resume plan built without it would miss
    // the agent's identity mechanism) AND the catalog (see `ready`).
    const ctx = spawnContext.get();
    if (!ctx || !booted) return;
    planLivePanes(ctx);
    const state = deck.getSnapshot();
    const active = findWorkspace(state.workspaces, state.activeId);
    if (!active) return;
    const commands = agents.commands();

    for (const ws of state.workspaces) {
      for (const pane of ws.panes) {
        // One question, one answer: a decision the user or the policy made, an
        // agent no plugin provides, a directory that is gone, a workspace
        // nobody has opened — and the reason it gives is the reason the card
        // shows.
        const agentType = paneAgentType(pane);
        const intent = paneRunIntent(pane, {
          agentAvailable: commands.has(agentType),
          missingDir: blocked.get(pane.id) ?? null,
          workspaceActive: ws.id === active.id,
          parkOnLaunch: launchPolicy.parkOnLaunch(),
          startOwed: startOwed.has(pane.id),
        });
        if (intent.kind === "run" && !pane.idle) {
          // A pane with no marker: it should run, and the only question left
          // is whether it already does and whether there is anything to run.
          // Never a reason to END one — this pass starts processes only.
          //
          // Unless a restart owns it. A restart retires the process and starts
          // it again, and the retiring half empties the slot — which looks
          // exactly like a pane that should be started. Spawning here would
          // race the restart's own continuation: it would then finish against
          // a process it did not start, and its stand-down path would revoke a
          // LIVE process's bridge token, silencing that agent's reports for
          // good. The restart schedules another pass when it is done.
          if (restarting.has(pane.id)) continue;
          if (sessions.state(pane.id).kind !== "none") {
            // It has one: the debt is paid.
            startOwed.delete(pane.id);
            continue;
          }
          const spec = peekPaneSpawnSpec(pane.id);
          if (!spec) continue;
          sessions.acquire(pane.id, {
            command:
              spec.command !== undefined
                ? spec.command
                : (commands.get(agentType) ?? agentType),
            args: spec.args,
            env: spec.env,
            envDefaults: spec.envDefaults,
            cwd: paneExecutionCwd(ws, pane),
            ...SPAWN_PLACEHOLDER_SIZE,
          });
          continue;
        }
        if (!pane.idle || inFlight.has(pane.id)) continue;
        if (intent.kind === "hold") {
          // A pane the launch policy holds is not merely skipped: it stops
          // rising, so its card says "stopped" and offers Resume instead of
          // promising a start that is never coming. Only that reason — every
          // other hold either already has its own marker or describes a
          // condition the pane should keep waiting on.
          if (
            intent.reason.kind === "stopped" &&
            intent.reason.by.reason === "parked"
          ) {
            actions.parkPane(ws.id, pane.id);
          }
          continue;
        }
        const sessionId = intent.resume?.sessionId ?? null;
        inFlight.add(pane.id);
        // A remote pane's agent runs against a VPS endpoint — it has no local
        // working directory to probe (so a gone workspace cwd never blocks it)
        // and no recorded session to resume (fresh-session only). Wake it
        // straight to a fresh remote plan built by the spawn-spec sweep.
        if (paneIsRemoteFresh(pane)) {
          void wake(ws, pane, ws.cwd, sessionId).finally(() =>
            inFlight.delete(pane.id),
          );
          continue;
        }
        const dir = pane.cwd ?? ws.cwd;
        void probe(dir)
          .then((probed) => {
            if (probed.exists) return wake(ws, pane, dir, sessionId);
            settle(ws.id, pane, { kind: "blocked", dir });
          })
          // A probe that REJECTS is a failed attempt like any other: it used
          // to wake the pane fresh regardless of who asked, which is exactly
          // the silent substitution the manual origin exists to prevent.
          .catch((e) =>
            settle(ws.id, pane, { kind: "failed", why: describeError(e) }),
          )
          .finally(() => inFlight.delete(pane.id));
      }
    }
  }

  deck.subscribe(schedule);
  // A plan landing is what a pane waiting to start is waiting FOR, and what a
  // card saying "Waking up…" is waiting to stop saying. Several paths write
  // that cache — the sweep, a manual resume, a fork's surgery, a retry — and
  // the ones that go through an await used to reach neither the view nor the
  // next pass: a resumed pane got a real process behind a permanent
  // placeholder, and the plan-error tile's Retry rebuilt nothing.
  subscribeSpawnSpecs(() => {
    publish();
    schedule();
  });
  spawnContext.subscribe(schedule);
  agents.subscribe(schedule);
  launchPolicy.subscribe(schedule);
  sessions.subscribe(schedule);
  void agents.ready().then(() => {
    booted = true;
    schedule();
  });
  // The deck may already hold restored panes by the time this is built (boot
  // hydration races the plugin bootstrap), and a source that never changes
  // again would leave them waiting on a notification that is not coming.
  schedule();

  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    createPane: landPane,
    createWorkspace(config) {
      const setup = config.setup?.trim() || undefined;
      // Allocation and insertion are one operation on the state owner, so two
      // creates in the same batch cannot observe or append the same id.
      const created = actions.createWorkspaceFromSequence((seq): Workspace => {
        const name = config.name.trim() || `workspace-${seq}`;
        return {
          id: `ws-${seq}`,
          instance: createWorkspaceInstance(),
          name,
          cwd: config.cwd,
          worktreeBaseDir: config.worktreeBaseDir,
          // Core field since deck v5: provisioning owns the setup command —
          // it runs whether or not the Run plugin is installed.
          ...(setup && { setup }),
          panes: planPanes(
            { cwd: config.cwd, worktreeBaseDir: config.worktreeBaseDir, name },
            mintAgentSeqs(config.count),
            config.count,
            config.agentType,
            config.yolo ?? false,
          ),
        };
      });
      if (!created.ok) {
        log.error(
          "web:orchestrator",
          `workspace create rejected: ${created.reason}`,
        );
        return created;
      }
      provisionPanes(created.workspace, created.workspace.panes);
      return created;
    },
    retryProvisioning(wsId, paneId) {
      const workspaces = deck.getSnapshot().workspaces;
      const ws = findWorkspace(workspaces, wsId);
      const pane = findPane(workspaces, wsId, paneId);
      if (!ws || !pane?.provisioning) return;
      // Back to the creating card first, then re-issue the same intent.
      actions.setPaneProvisioningError(wsId, paneId, null);
      provisionPanes(ws, [pane]);
    },
    async suspend(wsId, paneId) {
      if (suspending.has(paneId)) return "in-flight";
      const pane = findPane(deck.getSnapshot().workspaces, wsId, paneId);
      if (!pane) return "gone";
      // A pane the sweep found stuck on a gone folder has no process and is
      // going nowhere: every other surface already draws it as stopped, and
      // taking the gesture would write a durable `suspended` stamp over a
      // pane whose real problem is a missing directory.
      const refusal = paneSuspendBlock(pane, blocked.has(paneId));
      if (refusal) return refusal;
      suspending.add(paneId);
      try {
        log.info("web:orchestrator", `${paneId}: suspending`);
        // ORDER MATTERS, and it is the reverse of what closing does.
        //
        // Marking the pane idle FIRST takes it out of the run sweep and
        // unmounts its terminal. Tearing the process down first would leave a
        // live, plan-less pane for a beat — long enough for the sweep to
        // build it a fresh plan and acquire a NEW process, which the
        // following teardown would then orphan (unmounting a view never kills
        // a session; only closing the pane does).
        actions.suspendPane(wsId, paneId);
        // Revoke the bridge token before the process can report anything
        // else; a postback landing in the gap above is harmless (it binds the
        // pane's own real session, which is what a later resume wants).
        dropPaneSpawnSpec(paneId);
        clearPaneUsage(paneId);
        await sessions.close(paneId);
        return "suspended";
      } finally {
        suspending.delete(paneId);
      }
    },
    async close(request) {
      // Snapshot the ids before the reducer forgets them.
      const ws = findWorkspace(deck.getSnapshot().workspaces, request.wsId);
      const paneIds =
        request.kind === "agent"
          ? [request.paneId]
          : (ws?.panes.map((pane) => pane.id) ?? []);
      // A closing workspace's plugin-owned resources (the Run plugin's
      // sessions, say) die through the plugin event bridge's
      // onWorkspaceClosed — no per-feature teardown here.
      for (const paneId of paneIds) {
        // Revoke bridge authentication BEFORE the reducer drops membership;
        // neither an in-flight reporter nor a reused pane id may write again.
        dropPaneSpawnSpec(paneId);
        clearPaneUsage(paneId);
        // A fork card abandoned instead of retried leaves its post-provision
        // step registered (it is kept across a failure so Retry can re-run
        // it) — there is no Retry coming now.
        clearPostProvision(paneId);
      }
      // Leave the destructive intent for the creates that are still out, BEFORE
      // the reducer drops the panes: a create cannot be cancelled, so the only
      // way not to strand it is for it to find this when it lands. Registering
      // ahead of the removal is what makes it race-free — the create's own
      // "did my pane leave?" check cannot run before the pane has left.
      for (const paneId of request.pendingPanes) {
        discardWorktreeOnArrival(paneId);
      }
      if (request.kind === "agent") {
        actions.closeAgent(request.wsId, request.paneId);
      } else {
        actions.closeWorkspace(request.wsId);
      }
      await Promise.allSettled(paneIds.map((id) => sessions.close(id)));
      // Only AFTER the processes are reaped: a worktree that is still some
      // agent's cwd cannot be removed. The creates still out are NOT waited
      // on — they remove themselves through the intent left above, so a slow
      // one cannot hold this close (or the failures it reports) open.
      if (request.worktrees.length === 0) return [];
      return discardWorktrees(request.worktrees);
    },
    async restart(wsId, paneId, mode) {
      if (restarting.has(paneId)) return "in-flight";
      const target = restartTargetOf(wsId, paneId);
      if (!target) return "gone";
      restarting.add(paneId);
      // A restart takes the process away and owes one back, so the sweep must
      // start it even in a workspace nobody is looking at — otherwise the card
      // reports a restart that never comes.
      startOwed.add(paneId);
      try {
        // "Resume" with nothing recorded is a fresh start, and saying so here
        // keeps the log honest about which one actually ran.
        const effective = mode === "resume" && target.sessionId ? "resume" : "fresh";
        log.info("web:orchestrator", `${paneId}: manual restart (${effective})`);
        return effective === "resume"
          ? await restartResume(target)
          : await restartFresh(target);
      } catch (error) {
        log.warn(
          "web:orchestrator",
          `${paneId}: restart failed: ${describeError(error)}`,
        );
        throw error;
      } finally {
        restarting.delete(paneId);
        // The sweep stood aside while this ran; tell it to look again, or the
        // pane waits for an unrelated notification to start its new process.
        schedule();
      }
    },
    recoverRejectedResume(wsId, paneId, code) {
      const spec = peekPaneSpawnSpec(paneId);
      if (!resumeDiedSilently(spec, postbackCount(paneId))) return false;
      if (restarting.has(paneId)) return true;
      // A pane that is idle was stopped on purpose; respawning it here would
      // undo that AND wipe its binding. The suspend path drops the spawn spec
      // before reaping, so `resumeDiedSilently` already answers false — but
      // that is an ordering elsewhere, not a guarantee here.
      if (findPane(deck.getSnapshot().workspaces, wsId, paneId)?.idle) {
        return false;
      }
      const target = restartTargetOf(wsId, paneId);
      if (!target) return false;

      restarting.add(paneId);
      // Same debt as a restart, and this one is louder: the caller is told
      // "not a crash, a respawn is coming", so the crash notice is suppressed.
      // Without this the promise went unkept whenever the pane's workspace was
      // off screen — binding wiped, no process, and nothing said so.
      startOwed.add(paneId);
      log.warn(
        "web:orchestrator",
        `${paneId}: resume of ${spec?.resumeOf} exited (${code ?? "?"}) without reporting — respawning fresh`,
      );
      actions.setPaneSession(target.workspace.id, paneId, null);
      dropPaneSpawnSpec(paneId);
      clearPaneUsage(paneId);
      void sessions
        .close(paneId)
        .then(() => {
          if (restartTargetOf(target.workspace, paneId)) bumpEpoch(paneId);
        })
        .finally(() => {
          restarting.delete(paneId);
          schedule();
        });
      return true;
    },
    retryPlanBuild(paneId) {
      dropPaneSpawnSpec(paneId);
      clearPanePlanError(paneId);
      bumpEpoch(paneId);
    },
    async resumeSession(wsId, record, opts) {
      const ctx = spawnContext.get();
      if (!ctx) throw new Error("Agent spawn context is unavailable");
      const ws = findWorkspace(deck.getSnapshot().workspaces, wsId);
      if (!ws) return;
      if (resuming.has(record.sessionId)) return;
      // A session runs in at most one pane, ever. The browser offers Resume
      // for every row (it cannot know lifecycle), so say why rather than
      // leaving an enabled button that does nothing. An IDLE claimant is not
      // "running" — point at the pane that owns the binding.
      const claimant = sessionClaimant(
        deck.getSnapshot().workspaces,
        record.sessionId,
        (paneId) => blocked.has(paneId),
      );
      if (claimant) {
        throw new Error(
          claimant.reads === "stopped"
            ? "The session already belongs to a stopped pane — resume that pane instead"
            : "The session is already running in a pane",
        );
      }
      // An explicit override (a dialog with a YOLO toggle) wins; a bare
      // browser resume passes nothing and inherits the recorded mode.
      const yolo = opts?.yolo ?? record.yolo;
      resuming.add(record.sessionId);
      try {
        const id = paneId(mintAgentSeqs(1));
        const built = await buildResumeSpec(
          plugins,
          record.agent,
          {
            paneId: id,
            workspace: { id: ws.id, instance: ws.instance },
            cwd: record.cwd,
            branch: record.branch,
            yolo,
            // The pane isn't in the deck yet, so its cwd can't come from
            // `skillRootsOf` — stage it explicitly.
            wsSkillRoots: [record.cwd],
          },
          ctx,
          record.sessionId,
          "manual",
        );
        if (!built || peekPaneSpawnSpec(id)?.resumeOf !== record.sessionId) {
          dropPaneSpawnSpec(id);
          throw new Error("Agent could not prepare a resume plan");
        }
        // The session may have been claimed while the build was out (a
        // concurrent revive) — then there is nothing left to resume. Same
        // question as the check above, so the same answer.
        const claimedNow = sessionClaimant(
          deck.getSnapshot().workspaces,
          record.sessionId,
          (paneId) => blocked.has(paneId),
        );
        if (claimedNow) {
          dropPaneSpawnSpec(id);
          return;
        }
        const name = opts?.name?.trim();
        const landed = landPane({
          workspace: { id: ws.id, instance: ws.instance },
          pane: {
            id,
            agentType: record.agent,
            // A cwd of the workspace's own dir is the plain-pane default;
            // only a foreign dir (the session's worktree) pins the pane,
            // restoring the exact shape the original pane had.
            ...(record.cwd !== ws.cwd && { cwd: record.cwd }),
            ...(record.branch !== undefined && { branch: record.branch }),
            ...(yolo && { yolo: true }),
            ...(name && { name }),
            session: {
              id: record.sessionId,
              boundAt: new Date().toISOString(),
            },
          },
        });
        landOrThrow(landed);
      } catch (error) {
        log.warn(
          "web:orchestrator",
          `resume of ${record.sessionId} failed: ${describeError(error)}`,
        );
        throw error;
      } finally {
        resuming.delete(record.sessionId);
      }
    },
    async forkSession(wsId, record, target, opts) {
      const ctx = spawnContext.get();
      if (!ctx) throw new Error("Agent spawn context is unavailable");
      const ws = findWorkspace(deck.getSnapshot().workspaces, wsId);
      if (!ws) return;
      if (forking.has(record.sessionId)) return;
      const yolo = opts?.yolo ?? record.yolo;
      const workspace = { id: ws.id, instance: ws.instance };
      forking.add(record.sessionId);
      try {
        const id = paneId(mintAgentSeqs(1));
        const name = opts?.name?.trim();
        // The plugin's surgery, caching the fork plan for `id`. Run against
        // the directory the fork will LIVE in.
        const surgery = (cwd: string) =>
          buildForkSpec(
            plugins,
            record.agent,
            {
              paneId: id,
              workspace,
              cwd,
              yolo,
              wsSkillRoots: [cwd],
            },
            ctx,
            {
              sessionId: record.sessionId,
              sourceCwd: record.cwd,
              ...(record.transcriptPath !== undefined && {
                transcriptPath: record.transcriptPath,
              }),
            },
          );

        if (target.kind === "dir") {
          // Bail BEFORE the irreversible surgery (export→rekey→import) if the
          // workspace is already full — else it creates an orphan clone and
          // only then finds out there is nowhere to put it. The landing's own
          // check still guards the gap the await opens.
          if (ws.panes.length >= MAX_PANES) {
            throw new Error(WORKSPACE_FULL_MESSAGE);
          }
          // The target already exists — run the surgery up front.
          if (!(await surgery(target.cwd))) {
            dropPaneSpawnSpec(id);
            throw new Error("Agent could not prepare a fork plan");
          }
          const landed = landPane({
            workspace,
            pane: {
              id,
              agentType: record.agent,
              ...(target.cwd !== ws.cwd && { cwd: target.cwd }),
              ...(opts?.branch && { branch: opts.branch }),
              ...(yolo && { yolo: true }),
              ...(name && { name }),
            },
          });
          landOrThrow(landed);
          return;
        }

        // A new worktree. The pane lands as a provisioning card; the create
        // lands the worktree, and only THEN does the surgery run — bound to
        // the CREATED worktree, so opencode's import relocates the session
        // there. Throwing from the step is how `provisionPane` learns to roll
        // the worktree back and fail the card.
        registerPostProvision(id, async (worktree) => {
          if (!(await surgery(worktree.cwd))) {
            throw new Error("Agent could not prepare a fork plan");
          }
        });
        const landed = landPane({
          workspace,
          pane: {
            id,
            agentType: record.agent,
            ...(yolo && { yolo: true }),
            ...(name && { name }),
            provisioning: {
              repo: ws.cwd,
              path: target.path,
              branch: target.branch,
              ...(target.base !== undefined && { base: target.base }),
              workspace: ws.name,
              index: ws.panes.length + 1,
              // Marks this card a FORK: its surgery is an in-memory step, so
              // a restart-interrupted fork card must NOT restore as a plain
              // retryable card (it would Retry into a non-fork pane).
              fork: true,
            },
          },
        });
        landOrThrow(landed);
      } catch (error) {
        log.warn(
          "web:orchestrator",
          `fork of ${record.sessionId} failed: ${describeError(error)}`,
        );
        throw error;
      } finally {
        forking.delete(record.sessionId);
      }
    },
    startFresh(wsId, paneId) {
      let changed = blocked.delete(paneId);
      changed = wakeFailed.delete(paneId) || changed;
      if (changed) publish();
      startOwed.add(paneId);
      actions.resetPaneLocation(wsId, paneId);
      // Ask for a wake rather than clearing the marker outright: the pane is
      // pointed at the workspace folder now, and the sweep should probe it like
      // any other before mounting a terminal there.
      actions.requestPaneWake(wsId, paneId);
    },
    resume(wsId, paneId) {
      const pane = findPane(deck.getSnapshot().workspaces, wsId, paneId);
      if (!pane) return "gone";
      if (pane.provisioning) return "provisioning";
      if (!pane.idle) return "running";
      // The same catalog gate the sweep applies. Asked here too, because the
      // sweep's version is a silent skip: marking the pane first would strand
      // it in a state nothing settles.
      if (!agents.commands().has(paneAgentType(pane))) return "unavailable";
      // Clear the last attempt's verdicts first: a stale block would make the
      // sweep skip this pane forever, and a stale note would explain a failure
      // the user is already retrying.
      let changed = blocked.delete(paneId);
      changed = wakeFailed.delete(paneId) || changed;
      if (changed) publish();
      startOwed.add(paneId);
      actions.requestPaneWake(wsId, paneId);
      return "resuming";
    },
  };
}
