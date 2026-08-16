import type { AgentRestartMode, ForkTarget } from "../../domain/agents";
import type { SpawnPlan } from "../spawnSpecs";
import type { Pane, SpawnConfig, WorktreeTarget } from "../../domain/deck";
import type { SessionHandle } from "../../domain/journal";
import type { McpAccessAsk } from "../mcp";
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
  /** Register a workspace and optimistically land its agent panes. */
  createWorkspace(config: SpawnConfig): WorkspaceCreationResult;
  /** Re-issue a failed pane's worktree create. */
  retryProvisioning(wsId: string, paneId: string): void;
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
  /** Re-run the pane whose refused resume turned out to be live, opening
   * the agent's own session-manager screen in this pane's terminal. */
  openOccupiedManager(wsId: string, paneId: string): Promise<void>;
  /** Fork the live session a refused-resume card holds into a copy in the
   * SAME directory (the card never chooses one) — a new pane, the binding
   * untouched. */
  forkOccupiedSession(wsId: string, paneId: string): Promise<void>;
  /** Stop offering the occupied choice: the pane stays visible and bound,
   * nothing is erased — the ordinary exit card takes over. */
  dismissOccupied(paneId: string): void;
  /** Continue a journal session in a new pane. */
  resumeSession(
    wsId: string,
    record: SessionHandle,
    opts?: { name?: string; yolo?: boolean },
  ): Promise<void>;
  /** Fork a journal session into a new pane and target directory/worktree. */
  forkSession(
    wsId: string,
    record: SessionHandle,
    target: ForkTarget,
    opts?: { name?: string; branch?: string; yolo?: boolean },
  ): Promise<void>;
  /** Detach a blocked pane from its missing worktree and start fresh. */
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
  /** Current cached spawn plans. */
  specs: Record<string, SpawnPlan>;
  /** Panes whose plan build failed before a process started. */
  planFailed: ReadonlySet<string>;
  /** paneId → terminal mount generation. */
  epochs: Record<string, number>;
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
  pane: Pane;
}

export type CreatePaneOutcome =
  | { kind: "created" }
  | { kind: "gone" }
  | { kind: "full" };

export type CloseRequest = {
  /** Destructive choice from the confirmation surface. */
  deleteWorktrees: boolean;
  /** Worktrees probed when the confirmation surface opened. */
  worktrees: WorktreeTarget[];
} & (
  | { kind: "agent"; wsId: string; paneId: string }
  | { kind: "workspace"; wsId: string }
);

export type RestartOutcome =
  | "restarted"
  | "in-flight"
  | "gone"
  | "stopped";

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
  acquire(paneId: string, spec: PaneSpawnSpec): void;
  close(paneId: string): Promise<void>;
  runOnce(
    paneId: string,
    spec: PaneSpawnSpec,
  ): Promise<{ ok: boolean; tail: string }>;
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
}

export function createAgentOrchestrator(
  deps: AgentOrchestratorDeps,
): AgentOrchestrator {
  return createAgentOrchestratorRuntime(deps);
}
