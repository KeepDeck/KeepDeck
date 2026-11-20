import type { AgentRestartMode, ForkTarget } from "../../domain/agents";
import type { CwdArmAsk, McpAccessAsk, SpawnPlan } from "../spawnSpecs";
import type { AgentReach, SpawnConfig, TeamActs, UnheldRemovalRequest } from "../../domain/deck";
import type { AgentDraft, Consent, IntentOutcome, ResumeOutcome, Site, SuspendResult } from "../../domain/lifecycle";
import type { SessionHandle } from "../../domain/journal";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import type { Intent } from "../../ipc/generated/lifecycle/Intent";
import type { LeaseAsk } from "../../ipc/generated/lifecycle/LeaseAsk";
import type { PermitId } from "../../ipc/generated/lifecycle/PermitId";
import type { Reply } from "../../ipc/generated/lifecycle/Reply";
import type { Snapshot } from "../../ipc/generated/lifecycle/Snapshot";
import type { DeckStore } from "../deckStore";
import type { PaneRunState } from "../lifecycle/paneRunState";
import type { PaneLaunch, PaneSessionState, PaneSpawnSpec } from "../ptyManager";
import type { SpawnContextSource } from "../spawnContextSource";
import type { SpawnPluginAccess } from "../spawnSpecs";
import type { StagedSkills } from "../worktrees";
import { createAgentOrchestratorRuntime } from "./runtime";

/**
 * The owner of an agent pane's run: whether a process should be behind it,
 * and if not, why — the one funnel that plans, wakes and launches by lease.
 * Deliberately outside React: the processes it governs outlive any render.
 *
 * Every change to the deck's shape — a workspace, team or agent made or
 * closed, a suspend, a resume, an archive, a restart, a session continued, a
 * member moved — is an intent to the lifecycle machine through these doors,
 * answered by an [`IntentOutcome`]; what the machine then does reaches the
 * deck as its commands. Wake and park stay the page's.
 */
export interface AgentOrchestrator {
  /** Stable render snapshot for panes that are not running. */
  getView(): AgentRunView;
  subscribe(listener: () => void): () => void;
  /** Whether this pane's agent would read something sent to it now — the
   * run decision the funnel makes, met with its process — or null for a pane
   * the deck does not hold. */
  reachOf(paneId: string): AgentReach | null;
  /** Seat a new agent: on the team it names, the team already working at the
   * place it asks for, or a new team made there. */
  createPane(request: CreatePaneRequest): Promise<IntentOutcome>;
  /** Make a team that holds a place and nobody yet — the "+ Team" door. */
  createTeam(request: CreateTeamRequest): Promise<IntentOutcome>;
  /** Make a workspace, born empty. */
  createWorkspace(config: SpawnConfig): Promise<IntentOutcome>;
  /** Ask again for a team's worktree whose creation failed. */
  retryProvisioning(wsId: string, teamId: string): Promise<IntentOutcome>;
  /** Stop an agent while preserving its resumable pane. */
  suspend(wsId: string, paneId: string): Promise<SuspendResult>;
  /** Suspend the members of a team its confirm NAMED that the team's Suspend
   * would still take now — never one it did not name. */
  suspendTeam(wsId: string, teamId: string, named: readonly string[]): Promise<IntentOutcome[]>;
  /** A confirmed close, with exactly what its dialog was consented to. */
  close(request: CloseRequest): Promise<IntentOutcome>;
  /** Put a workspace away: its agents stopped and kept, its folders kept. */
  archive(workspace: WorkspaceRef): Promise<IntentOutcome>;
  /** Bring an archived workspace back; nobody in it is woken. */
  restore(workspace: WorkspaceRef): Promise<IntentOutcome>;
  /** Remove a checkout of the workspace's repository nobody holds — one
   * operation of the machine, which refuses one held by now. */
  removeUnheld(workspace: WorkspaceRef, request: UnheldRemovalRequest): Promise<IntentOutcome>;
  /** Restart a pane's agent: the machine stops its exact session, and the
   * funnel launches it again — on its recorded session, or fresh. */
  restart(wsId: string, paneId: string, mode: AgentRestartMode): Promise<IntentOutcome>;
  /** Recover a rejected boot-time resume: ask the live registry before
   * touching the binding — a session held by an outside process keeps it and
   * offers the choice, an absent one earns one quiet retry, and only the
   * second silent death (or no registry to ask) falls back fresh. Answers
   * whether it took the pane over (the caller then stays quiet). */
  recoverRejectedResume(wsId: string, paneId: string, code: number | null): boolean;
  /** Retry a failed spawn-plan build. */
  retryPlanBuild(paneId: string): void;
  /** Stop offering the occupied choice: the pane stays visible and bound,
   * nothing is erased — the ordinary exit card takes over. */
  dismissOccupied(paneId: string): void;
  /** Continue a journal session in a new pane: on the team it names, the
   * team working in the session's folder, or a new team made there. `role`
   * is the pane's address on that team. */
  resumeSession(wsId: string, record: SessionHandle, opts: ContinueOptions): Promise<IntentOutcome>;
  /** Fork a journal session into a new pane in `target`. */
  forkSession(wsId: string, record: SessionHandle, target: ForkTarget, opts: ContinueOptions): Promise<IntentOutcome>;
  /** Move a pane whose team's folder is gone onto the workspace root's team
   * and start a fresh conversation there; `role` is the person's pick when
   * its own cannot come along. */
  startFresh(wsId: string, paneId: string, role?: string): Promise<IntentOutcome>;
  /** Ask for a stopped pane back: a suspended one through the machine, one
   * parked by the launch policy (or whose wake failed) by the page's own
   * ask. Refused up front when the pane cannot rise now. */
  resume(wsId: string, paneId: string): Promise<ResumeOutcome>;
  /** Ask back every member a team's Resume would take now. */
  resumeTeam(wsId: string, teamId: string): Promise<ResumeOutcome[]>;
  /** Whom a team's Suspend and Resume would take right now, and why each
   * other member stays — what its menu offers, read from the same facts its
   * doors judge by. Null for a team (or workspace) that is not there. */
  teamActs(wsId: string, teamId: string): TeamActs | null;
  /** The owners of the machine's launch-state and fork-step commands: a
   * pane's plan ended before each stop, a continued session's plan built
   * for the pane the machine minted. */
  runState: PaneRunState;
}

export interface AgentRunView {
  /** paneId → missing directory. */
  blocked: Record<string, string>;
  /** paneId → manual wake-plan failure. */
  wakeFailed: Record<string, string>;
  /** paneId → the live-outside note whose choice the pane's card offers. */
  occupied: Record<string, OccupiedNote>;
  /** paneId → the wait a continuation's start is in. */
  startup: Record<string, StartupNote>;
  /** Current cached spawn plans. */
  specs: Record<string, SpawnPlan>;
  /** Panes whose plan build failed before a process started. */
  planFailed: ReadonlySet<string>;
  /** paneId → terminal mount generation. */
  epochs: Record<string, number>;
}

/**
 * A continuation that has been asked to start and has not painted yet.
 *
 * The MOMENT the wait began is published, never the elapsed time: the view
 * counts the seconds off it, so the application publishes twice per wait —
 * once when the wait starts, once when it outlasts a healthy one — instead of
 * once a second.
 */
export interface StartupNote {
  /** When this pane was asked to continue its session. */
  since: number;
  /** The wait has already gone on longer than a healthy start takes, so the
   * pane says so and offers a way out. */
  slow: boolean;
}

/** A refused boot resume that turned out to be a live outside session —
 * the note the pane's card explains itself with. */
export interface OccupiedNote {
  /** Whether the registry PROVED the session live, or merely failed to
   * answer (the card words the difference — a person must know what is
   * known and what is not). */
  registry: "live" | "unknown";
  /** The conversation's own name, when the registry knew one. */
  name: string | null;
}

export interface CreatePaneRequest {
  /** Exact workspace lifetime: a request that outlived it reaches nothing. */
  workspace: WorkspaceRef;
  pane: AgentDraft;
  /** Its role on the team it lands on — honoured or refused, never replaced. */
  role: string;
  /** The team to JOIN, by id. Wins over `site`. */
  team?: string;
  /** Where the agent asks to run. Absent: the workspace root. */
  site?: Site;
  /** The name for a team the request makes; the deck's auto name for none. */
  teamName?: string;
}

/** A team born with its place and nobody on it — the "+ Team" door. */
export interface CreateTeamRequest {
  workspace: WorkspaceRef;
  /** What the team is called; blank takes the deck's auto name. */
  name: string;
  site: Site;
}

/** How a continued session lands: its name, mode and role in the new pane,
 * and the team it joins by id — absent, the team working in its folder. */
export interface ContinueOptions {
  name?: string;
  yolo?: boolean;
  role: string;
  team?: string;
}

/**
 * A confirmed close, addressed by `WorkspaceRef` — a confirmation that
 * outlived its workspace reaches nothing — and carrying exactly what its
 * dialog was consented to.
 *
 * Three verbs, because they end three different things:
 * - `agent` ends ONE agent: its process, its session, its place on its team.
 * - `team` disbands: every member, the team, and the folders consented to.
 * - `workspace` disbands every team, then the workspace.
 */
export type CloseRequest =
  | { kind: "agent"; workspace: WorkspaceRef; paneId: string; consent: Consent }
  | { kind: "team"; workspace: WorkspaceRef; teamId: string; consent: Consent }
  | { kind: "workspace"; workspace: WorkspaceRef; consent: Consent };

/** Delay the MCP lookup until a spawn plan is actually built — and ask per
 * build, never once: the transport can go up or down between two spawns.
 * Owned by the MCP feature, and passed straight through to the spawn plan;
 * re-exported so the orchestrator's own deps read in one place. */
export type { CwdArmAsk, McpAccessAsk };

/** Delay staged-skill lookup until a spawn plan is actually built. */
export type StagedSkillsAsk = (workspace: WorkspaceRef) => () => ReturnType<StagedSkills["skillsFor"]>;

export interface AgentCatalogPort {
  /** Agent id → fallback executable. */
  commands(): ReadonlyMap<string, string>;
  /** Resolves once plugin discovery and activation have settled. */
  ready(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export type WorktreeProbePort = (dir: string) => Promise<{ exists: boolean }>;

export interface LaunchPolicyPort {
  parkOnLaunch(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface SessionRegistryPort {
  subscribe(listener: () => void): () => void;
  state(paneId: string): PaneSessionState;
  /** Whether this pane's process has produced any output yet — the CLI has
   * painted. Separate from [`state`] because the first byte and the spawn
   * promise are independent notifications with no guaranteed order. */
  isLaunched(paneId: string): boolean;
  acquire(paneId: string, spec: PaneSpawnSpec, launch: PaneLaunch): void;
  /** Let go of what the page holds for a pane whose process is over. */
  close(paneId: string): Promise<void>;
}

/** Retire a pane's per-process state (usage, activity, and which session it
 * has bound) when its process retires. */
export interface PaneLifecyclePort {
  retire(paneId: string): void;
}

/** The lifecycle machine, as the orchestrator reaches it: its intents, its
 * launch leases, the snapshot it publishes, and the fork step's end. */
export interface LifecycleMachinePort {
  send(intent: Intent): Promise<Reply>;
  lease(ask: LeaseAsk): Promise<Reply>;
  release(permit: PermitId): Promise<void>;
  /** The newest snapshot, or null before the first. */
  snapshot(): Snapshot | null;
  subscribe(listener: () => void): () => void;
  /** The fork step's hook call has ended — its outcome or not. */
  hookEnded(op: number): void;
}

/** Where a recorded session's transcript file is, when the journal never
 * learned it — the session index's answer. */
export interface TranscriptLocatorPort {
  locateTranscript(agent: string, sessionId: string): Promise<string | null>;
}

/** The bindings the binding lane accepted — a continued pane's session
 * reported by its own process. */
export interface BindingsPort {
  subscribe(listener: (bound: { paneId: string }) => void): () => void;
}

export interface AgentOrchestratorDeps {
  deck: DeckStore;
  spawnContext: SpawnContextSource;
  agents: AgentCatalogPort;
  launchPolicy: LaunchPolicyPort;
  sessions: SessionRegistryPort;
  plugins: SpawnPluginAccess;
  probe: WorktreeProbePort;
  /** The staged skills a spawn plan is handed. */
  skills: StagedSkills;
  /** A spawning pane's MCP access — servers for its argv, and the on-disk
   * delivery for a CLI that takes none. Empty while the transport is down. */
  mcpAccess: McpAccessAsk;
  /** Planting what an agent's plugin declares in a spawning pane's cwd. */
  armCwd: CwdArmAsk;
  lifecycle: PaneLifecyclePort;
  machine: LifecycleMachinePort;
  transcripts: TranscriptLocatorPort;
  bindings: BindingsPort;
}

export function createAgentOrchestrator(deps: AgentOrchestratorDeps): AgentOrchestrator {
  return createAgentOrchestratorRuntime(deps);
}
