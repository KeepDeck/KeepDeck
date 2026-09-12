import type { AgentRestartMode, ForkTarget } from "../../domain/agents";
import type { McpAccessAsk, SpawnPlan } from "../spawnSpecs";
import type {
  Pane,
  PlacementRefusal,
  SpawnConfig,
  TeamLocation,
  WorktreeTarget,
} from "../../domain/deck";
import type { SessionHandle } from "../../domain/journal";
import type { RoleRefusal } from "../../domain/mail";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import type { WorkspaceCreationResult } from "../deckActions";
import type { DeckStore } from "../deckStore";
import type { PaneSessionState, PaneSpawnSpec } from "../ptyManager";
import type { SpawnContextSource } from "../spawnContextSource";
import type { SpawnPluginAccess } from "../spawnSpecs";
import type { SuspendOutcome } from "../suspendOutcome";
import type { WorktreeProvisioner } from "../worktrees";
import { createAgentOrchestratorRuntime } from "./runtime";

/**
 * The owner of an agent pane's run lifecycle.
 *
 * It answers one question for every pane — should a process be behind it,
 * and if not, why — and drives the primitives that make reality match.
 * Deliberately outside React: the processes it governs outlive any render.
 */
export interface AgentOrchestrator {
  /** Stable render snapshot for panes that are not running. */
  getView(): AgentRunView;
  subscribe(listener: () => void): () => void;
  /** Land and provision a pane through the common creation sequence. */
  createPane(request: CreatePaneRequest): CreatePaneOutcome;
  /** Make a team that holds a directory and nobody yet — the "+ Team"
   * door; its worktree create starts behind the card. */
  createTeam(request: CreateTeamRequest): CreateTeamOutcome;
  /** Register a workspace and optimistically land its agent panes. */
  createWorkspace(config: SpawnConfig): WorkspaceCreationResult;
  /** Re-issue a team's failed worktree create — the card is the team's. */
  retryProvisioning(wsId: string, teamId: string): void;
  /** Stop an agent while preserving its resumable pane. */
  suspend(wsId: string, paneId: string): Promise<SuspendOutcome>;
  /** Confirmed pane/workspace close, including optional worktree teardown. */
  close(request: CloseRequest): Promise<string[]>;
  /** Restart an exited pane fresh or against its recorded session. */
  restart(
    wsId: string,
    paneId: string,
    mode: AgentRestartMode,
  ): Promise<RestartOutcome>;
  /** Recover a rejected boot-time resume: ask the live registry before
   * touching the binding — a session held by an outside process keeps it
   * and offers the choice, an absent one earns one quiet retry, and only
   * the second silent death (or no registry to ask) falls back fresh.
   * Answers whether it took the pane over (the caller then stays quiet). */
  recoverRejectedResume(
    wsId: string,
    paneId: string,
    code: number | null,
  ): boolean;
  /** Retry a failed spawn-plan build. */
  retryPlanBuild(paneId: string): void;
  /** Fork the live session a refused-resume card holds into a copy in the
   * SAME directory (the card never chooses one) — a new pane, the binding
   * untouched. */
  forkOccupiedSession(wsId: string, paneId: string): Promise<void>;
  /** Fork the session a pane is bound to when its start has gone quiet: the
   * same directory, nothing killed, so a person who cannot wait any longer
   * has a way forward that costs nothing if the start was about to finish. */
  forkStalledSession(wsId: string, paneId: string): Promise<void>;
  /** Stop offering the occupied choice: the pane stays visible and bound,
   * nothing is erased — the ordinary exit card takes over. */
  dismissOccupied(paneId: string): void;
  /** Continue a journal session in a new pane. `role` is the address the
   * pane asks for on the team it lands on — honoured when the catalog knows
   * it and it is free, refused otherwise ([`admitRole`], thrown as the
   * refusal's words); absent, the roster suggests one. */
  resumeSession(
    wsId: string,
    record: SessionHandle,
    opts?: { name?: string; yolo?: boolean; role?: string },
  ): Promise<void>;
  /** Fork a journal session into a new pane and target directory/worktree.
   * `role` as for `resumeSession`. */
  forkSession(
    wsId: string,
    record: SessionHandle,
    target: ForkTarget,
    opts?: { name?: string; branch?: string; yolo?: boolean; role?: string },
  ): Promise<void>;
  /** Take a blocked pane off the team whose directory is gone, onto the
   * workspace root's, and start a fresh conversation there. */
  startFresh(wsId: string, paneId: string): void;
  /** Ask for a stopped pane back and report whether it can rise. */
  resume(wsId: string, paneId: string): ResumeRequest;
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
  /** Exact workspace lifetime, guarding asynchronous creation decisions. */
  workspace: WorkspaceRef;
  /** The pane as the request describes it. A remote endpoint is its own;
   * a directory never is. */
  pane: Pane;
  /** The directory the pane asks to run in — an existing one (the workspace
   * root included) or a create heading for one. The landing turns it into
   * the team the pane joins: the team already holding that directory, or a
   * new one made for it. Absent: the workspace root. */
  placement?: TeamLocation;
  /** The team to JOIN, by id — whatever its placement, a create still out
   * included. Wins over `placement`. A team that is not here, holds no
   * directory, or is being closed refuses `held`. */
  team?: string;
  /** The role the pane takes on its team, when the caller has one in mind:
   * honoured when the catalog knows it and it is free on the team, refused
   * otherwise (`role`). Absent, the roster suggests one. */
  role?: string;
  /** The name for a team the landing MINTS — when the caller is creating
   * one and named it; the pane's own name otherwise. Ignored when the pane
   * joins a team that already holds the directory. */
  teamName?: string;
  /** A step to run after the team's worktree lands and before its card
   * resolves — a journal fork's store surgery. Filed under the TEAM the
   * landing mints, which is why it rides the request rather than being
   * registered ahead of it under an id the caller would have to guess. */
  postProvision?: (worktree: { cwd: string; branch: string }) => Promise<void>;
}

export type CreatePaneOutcome =
  /** Landed, on the team named — the one holding the directory, or freshly
   * minted for it. */
  | { kind: "created"; teamId: string }
  | { kind: "gone" }
  /** The team the pane would join already has MAX_PANES members. */
  | { kind: "full" }
  /** The directory the pane asked for is nothing it can land on — `why`
   * says which of the reasons it was, so every door tells the truth in the
   * same words ([`createRefusalMessage`]). */
  | { kind: "held"; why: PlacementRefusal }
  /** The role the pane asked for cannot be its address on that team: it is
   * taken, or the catalog does not know it. Refused, never replaced — a
   * role asked for is honoured or refused ([`admitRole`]). */
  | { kind: "role"; why: RoleRefusal; role: string };

/** A team born with its directory and nobody on it — the "+ Team" door.
 * Agents come later, each through `createPane` naming the team. */
export interface CreateTeamRequest {
  workspace: WorkspaceRef;
  /** What the team is called; blank takes the deck's auto name. */
  name: string;
  /** The directory the team holds — an existing one (the workspace root
   * included) or a create heading for one. */
  placement: TeamLocation;
  /** The person has SEEN whose directory this is and asked for the team
   * anyway. Only ever answers a `shared` outcome — it lets a second team
   * onto a directory a team already works in, and nothing else: a create
   * still heading for a worktree, and a directory a teardown is removing,
   * refuse with or without it. */
  shared?: true;
}

/** The team already working in a directory a create asked for. Named so the
 * surface can say WHOSE it is before asking for consent; `workspace` is set
 * only when the holder is in another one. */
export interface DirectoryHolder {
  teamId: string;
  teamName: string;
  workspace?: string;
}

export type CreateTeamOutcome =
  | { kind: "created"; teamId: string }
  | { kind: "gone" }
  /** The directory is a team's already, and consent CAN place a second team
   * on it: teams share a directory when the person says so. Carries who is
   * there, and the directory as the create read it, so the surface can name
   * both and re-issue with `shared` — never deriving either itself. */
  | { kind: "shared"; holder: DirectoryHolder; directory: string }
  /** The directory cannot take this team however willing the person is —
   * `why` says which reason, in the vocabulary every door shares. */
  | { kind: "held"; why: PlacementRefusal }
  /** A team here already answers to that name. */
  | { kind: "taken" };

/** The destructive half of a close that can take worktrees with it. */
export interface WorktreeTeardown {
  /** Destructive choice from the confirmation surface. */
  deleteWorktrees: boolean;
  /** Worktrees probed when the confirmation surface opened. */
  worktrees: WorktreeTarget[];
}

/**
 * A confirmed close. Addressed by `WorkspaceRef`, never by id alone: a
 * `ws-N` slot is reused, and a confirmation that outlived its workspace
 * must not touch the one now living in its place.
 *
 * Three verbs, because they end three different things:
 * - `agent` ends ONE agent — its process, its session, its place on its
 *   team. Never a worktree: the directory is the team's, and a member
 *   leaving does not take it, so there is no teardown to ask about.
 * - `team` disbands: ends every member, removes the team, and — on the
 *   opt-in — its worktree.
 * - `workspace` disbands every team the workspace holds, then the
 *   workspace.
 */
export type CloseRequest =
  | { kind: "agent"; workspace: WorkspaceRef; paneId: string }
  | ({ kind: "team"; workspace: WorkspaceRef; teamId: string } & WorktreeTeardown)
  | ({ kind: "workspace"; workspace: WorkspaceRef } & WorktreeTeardown);

export type RestartOutcome =
  | "restarted"
  | "in-flight"
  | "gone"
  | "stopped"
  /** The pane's worktree is still being created: there is no directory to
   * restart into, and its card offers Retry instead. */
  | "provisioning";

export type ResumeRequest =
  | "resuming"
  | "running"
  | "provisioning"
  | "unavailable"
  | "gone";

/** Delay the MCP lookup until a spawn plan is actually built — and ask per
 * build, never once: the transport can go up or down between two spawns.
 * Owned by the MCP feature, and passed straight through to the spawn plan;
 * re-exported so the orchestrator's own deps read in one place. */
export type { McpAccessAsk };
export { createRefusalMessage, type CreateRefusal } from "./refusals";

/** Delay staged-skill lookup until a spawn plan is actually built. */
export type StagedSkillsAsk = (
  workspace: WorkspaceRef,
  landing?: string,
) => () => ReturnType<WorktreeProvisioner["skillsFor"]>;

export interface AgentCatalogPort {
  /** Agent id → fallback executable. */
  commands(): ReadonlyMap<string, string>;
  /** Resolves once plugin discovery and activation have settled. */
  ready(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export type WorktreeProbePort = (
  dir: string,
) => Promise<{ exists: boolean }>;

export interface LaunchPolicyPort {
  parkOnLaunch(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface SuspendPolicyPort {
  moveToTray(): boolean;
}

export interface SessionRegistryPort {
  subscribe(listener: () => void): () => void;
  state(paneId: string): PaneSessionState;
  /** Whether this pane's process has produced any output yet — the CLI has
   * painted. Separate from [`state`] because the first byte and the spawn
   * promise are independent notifications with no guaranteed order. */
  isLaunched(paneId: string): boolean;
  acquire(paneId: string, spec: PaneSpawnSpec): void;
  close(paneId: string): Promise<void>;
}

/** Retire a pane's per-process state (usage, activity, and which session it
 * has bound) when its process retires — an injected port like every other
 * collaborator, so orchestrator tests hand in a fake instead of mocking a
 * module that writes to the app's live stores. */
export interface PaneLifecyclePort {
  retire(paneId: string): void;
}

export interface AgentOrchestratorDeps {
  deck: DeckStore;
  spawnContext: SpawnContextSource;
  agents: AgentCatalogPort;
  launchPolicy: LaunchPolicyPort;
  suspendPolicy: SuspendPolicyPort;
  sessions: SessionRegistryPort;
  plugins: SpawnPluginAccess;
  probe: WorktreeProbePort;
  /** Narrow role owning pane worktree creation, teardown and staged skills. */
  worktrees: WorktreeProvisioner;
  /** A spawning pane's MCP access — servers for its argv, and the on-disk
   * delivery for a CLI that takes none. Empty while the transport is down. */
  mcpAccess: McpAccessAsk;
  lifecycle: PaneLifecyclePort;
  /** Forget what the backend keeps per workspace when one closes — Rust
   * cannot derive the live workspace set. Optional: absent in non-app tests. */
  workspaceForgetters?: readonly ((wsId: string) => Promise<void>)[];
}

export function createAgentOrchestrator(
  deps: AgentOrchestratorDeps,
): AgentOrchestrator {
  return createAgentOrchestratorRuntime(deps);
}
