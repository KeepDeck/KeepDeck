import type { ComponentType } from "react";
import type { PluginManifest } from "./manifest.ts";

/**
 * The plugin context — everything a plugin may touch, handed to `activate`.
 *
 * Two rules shape every member:
 *
 * 1. **Transport-agnostic**: all inputs and outputs are serializable data and
 *    all service calls are async, so the same contract runs in-process
 *    (built-in tier) and over postMessage RPC (external tier, sandboxed).
 *    Nothing here hands out a live core object.
 * 2. **Cleanup by construction** (the Obsidian model): every `register*` and
 *    `on*` returns a `Disposable`, and the host disposes ALL of them when the
 *    plugin deactivates — an explicit `deactivate` is for the plugin's own
 *    resources only, not for undoing registrations.
 */
export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly ui: PluginUi;
  readonly settings: PluginSettings;
  readonly agents: PluginAgents;
  readonly storage: PluginStorage;
  readonly events: PluginEvents;
  readonly services: PluginServices;
  readonly log: PluginLogger;
}

export interface Disposable {
  dispose(): void;
}

// ---------------------------------------------------------------- ui

export interface PluginUi {
  /** Contribute a tab to the right dock. The dock itself is host chrome —
   * it exists only while at least one tab is registered. */
  registerDockTab(tab: DockTabContribution): Disposable;
  /** Contribute an icon action to the top bar's right cluster. */
  registerTopBarAction(action: TopBarActionContribution): Disposable;
  /** Contribute an icon action to every agent pane's header. */
  registerPaneAction(action: PaneActionContribution): Disposable;
}

/** Built-in tier: the tab is a React component rendered in the host tree.
 * (The external tier's iframe form joins this union with the sandbox.) */
export interface DockTabContribution {
  id: string;
  label: string;
  Component: ComponentType<DockTabProps>;
}

/** What every dock tab receives. Snapshots, not live state: the same shape
 * crosses the RPC boundary unchanged. */
export interface DockTabProps {
  workspace: WorkspaceSnapshot;
  selectedPaneId: string | null;
}

export interface TopBarActionContribution {
  id: string;
  title: string;
  Icon?: ComponentType;
  run(): void;
}

export interface PaneActionContribution {
  id: string;
  title: string;
  Icon?: ComponentType;
  run(target: { wsId: string; paneId: string }): void;
}

/** Serializable projection of a workspace — what plugins see instead of the
 * deck's own `Workspace`. */
export interface WorkspaceSnapshot {
  id: string;
  name: string;
  cwd: string;
  panes: PaneSnapshot[];
}

export interface PaneSnapshot {
  id: string;
  name: string;
  /** The pane's working directory; absent while provisioning. */
  cwd?: string;
  branch?: string;
  agentType: string;
}

// ---------------------------------------------------------------- settings

export interface PluginSettings {
  /** Contribute a settings section. The HOST renders the fields with its own
   * form components and owns the values — plugin code does not run while the
   * user types (the Raycast model). */
  registerSection(section: SettingsSectionContribution): Disposable;
  /** Current values for this plugin's fields (defaults applied). */
  read(): Promise<Record<string, unknown>>;
  /** Fires after any of this plugin's values change. */
  onChange(cb: (values: Record<string, unknown>) => void): Disposable;
}

export interface SettingsSectionContribution {
  label: string;
  fields: SettingsField[];
}

/** One host-rendered settings control. The vocabulary grows as real plugins
 * need more — never ahead of them. */
export type SettingsField =
  | {
      kind: "string";
      key: string;
      label: string;
      default: string;
      placeholder?: string;
      /** Render obscured; the value is still stored with the rest. */
      secret?: boolean;
    }
  | { kind: "boolean"; key: string; label: string; default: boolean }
  | { kind: "number"; key: string; label: string; default: number }
  | {
      kind: "select";
      key: string;
      label: string;
      default: string;
      options: { value: string; label: string }[];
    };

// ---------------------------------------------------------------- agents

export interface PluginAgents {
  /** Teach KeepDeck a CLI agent. Static identity is data; the CLI-specific
   * logic lives in hooks the host calls at lifecycle points, with
   * serializable input/output mutated in place (the opencode model). */
  register(agent: AgentContribution): Disposable;
}

export interface AgentContribution {
  id: string;
  label: string;
  /** How to find the CLI on this machine. */
  detect: { bin: string };
  hooks: AgentHooks;
}

export interface AgentHooks {
  /** Fill in how THIS CLI spawns for a pane: args, env, config injection. */
  "spawn.plan"?(
    input: SpawnPlanInput,
    output: SpawnPlanOutput,
  ): void | Promise<void>;
  /** Fill in how to resume a recorded session in a revived pane. */
  "resume.plan"?(
    input: ResumePlanInput,
    output: SpawnPlanOutput,
  ): void | Promise<void>;
}

export interface SpawnPlanInput {
  paneId: string;
  wsId: string;
  cwd: string;
  branch?: string;
  /** Pre-minted session identity the host expects the CLI to adopt. */
  sessionId: string;
  /** Where the session reporter posts binding events. */
  spoolPath: string;
}

export interface ResumePlanInput {
  paneId: string;
  wsId: string;
  cwd: string;
  /** The recorded session to resume. */
  sessionId: string;
  spoolPath: string;
}

/** Mutate-in-place spawn plan: hooks adjust what the host will run. */
export interface SpawnPlanOutput {
  /** Program to run; `null` = the user's shell. */
  command: string | null;
  args: string[];
  env: [string, string][];
}

// ---------------------------------------------------------------- storage

export interface PluginStorage {
  /** Per-workspace slot, persisted with the deck — dies with the workspace,
   * survives restarts. Namespaced by plugin id. */
  workspace(wsId: string): PluginKV;
  /** App-global store in the host's data dir — survives plugin reinstalls
   * (data never lives in the plugin's install folder). */
  readonly global: PluginKV;
}

export interface PluginKV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------- events

export interface PluginEvents {
  /** A workspace is closing — stop anything that belongs to it. */
  onWorkspaceClosed(cb: (e: { wsId: string }) => void): Disposable;
  /** The highlighted pane changed in some workspace. */
  onPaneSelected(
    cb: (e: { wsId: string; paneId: string | null }) => void,
  ): Disposable;
  /** Coarse "the deck changed" signal for cheap re-reads. */
  onDeckChanged(cb: () => void): Disposable;
}

// ---------------------------------------------------------------- services

/** Platform services, every call checked against the manifest's
 * capabilities before it runs (the CapabilityGate). */
export interface PluginServices {
  readonly sessions: PluginSessions;
  readonly ports: PluginPorts;
}

export interface PluginSessions {
  /** Spawn a PTY session (capability: `exec` covering the command). Closing
   * signals the whole process group. */
  spawn(
    opts: PluginSpawnOptions,
    onEvent: (event: PluginSessionEvent) => void,
  ): Promise<PluginSessionHandle>;
}

export interface PluginSpawnOptions {
  /** Program to run; omit for the user's shell. */
  command?: string | null;
  args?: string[];
  env?: [string, string][];
  cwd?: string;
  cols: number;
  rows: number;
}

export type PluginSessionEvent =
  | { type: "output"; bytes: Uint8Array }
  | { type: "exit"; code: number | null };

export interface PluginSessionHandle {
  readonly id: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

export interface PluginPorts {
  /** Deterministic 10-port block for `key` (capability: `ports`). */
  allocate(key: string): Promise<number>;
}

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
