import type { AgentRestartMode, ForkTarget, SpawnPlan } from "../../domain/agents";
import type { Pane, SpawnConfig, WorktreeTarget } from "../../domain/deck";
import type { SessionHandle } from "../../domain/journal";
import type { SpawnMcpInput } from "@keepdeck/plugin-api";
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
  /** Recover a rejected boot-time resume by respawning fresh, at most once. */
  recoverRejectedResume(
    wsId: string,
    paneId: string,
    code: number | null,
  ): boolean;
  /** Retry a failed spawn-plan build. */
  retryPlanBuild(paneId: string): void;
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
  /** Current cached spawn plans. */
  specs: Record<string, SpawnPlan>;
  /** Panes whose plan build failed before a process started. */
  planFailed: ReadonlySet<string>;
  /** paneId → terminal mount generation. */
  epochs: Record<string, number>;
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
 * build, never once: the transport can go up or down between two spawns. */
export type McpDefsAsk = () => Promise<SpawnMcpInput["servers"]>;

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
  /** The MCP servers a spawning pane should be given (empty while the
   * transport is down) — the injection half of the MCP feature. */
  mcpDefs: McpDefsAsk;
}

export function createAgentOrchestrator(
  deps: AgentOrchestratorDeps,
): AgentOrchestrator {
  return createAgentOrchestratorRuntime(deps);
}
