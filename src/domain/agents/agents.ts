/** Coding-agent kind a pane runs — an OPEN set now: ids come from cli
 *  plugins' agent contributions (`keepdeck.claude` / `keepdeck.codex` /
 *  `keepdeck.opencode` ship built-in), so this is a plain string, not a
 *  union. A pane may carry an id whose plugin is currently absent — that
 *  pane must surface "agent unavailable", never silently run a default. */
export type AgentType = string;

/** The host-side structural twin of the plugin usage capability contract. */
export type AgentUsageCapability = "paneTelemetry" | "accountLimits";

/** The host-side structural twin of the plugin-api `RemoteScheme`. Kept local
 *  (no plugin-api import) like `AgentUsageCapability`: data, not a contract
 *  reference. */
export type AgentRemoteScheme = "ws" | "wss" | "http" | "https";

/** A brand mark as bare SVG path data — the domain's structural twin of the
 *  plugin contract's icon (no plugin-api import; data, never markup).
 *  Multi-tone artwork is a stack of layers, painted in order. */
export interface AgentIcon {
  /** Coordinate space every layer is drawn in, e.g. `"0 0 24 24"`. */
  viewBox: string;
  /** Filled shapes, painted in order; single-color marks are one layer. */
  paths: AgentIconPath[];
}

/** One filled layer of a brand mark. */
export interface AgentIconPath {
  /** Path data; multiple subpaths are filled as one shape. */
  d: string;
  /** This layer's fill; omitted = inherit the surrounding text color. */
  color?: string;
  /** Fill rule the artwork was authored for; omitted = SVG's nonzero. */
  fillRule?: "evenodd";
}

/** An agent from the catalog (a cli plugin's contribution annotated with
 *  install detection). */
export interface AgentInfo {
  id: AgentType;
  label: string;
  /** The agent's brand mark, when its plugin ships one. */
  icon?: AgentIcon;
  /** CLI command to spawn (passed back to `session_spawn`). */
  command: string;
  /** Whether the CLI can run with permission prompts disabled (YOLO mode) —
   * gates the YOLO toggle wherever an agent is created. */
  supportsYolo: boolean;
  /** Whether the agent declares a remote capability (its plugin's
   *  `remote.mode === "nativeServer"`) — gates the "Where: Remote" option in
   *  the spawn dialog. Absent = no (the common case); the gate defaults
   *  false, so an agent that can't honor a target never gets one picked. */
  supportsRemote?: boolean;
  /** URI schemes the agent's remote client speaks, when it declares remote
   *  support; absent otherwise. The spawn dialog validates a pasted
   *  endpoint's scheme against these so the agent isn't paired with a scheme
   *  it can't speak. */
  remoteSchemes?: readonly AgentRemoteScheme[];
  /** Whether the CLI resolves on the augmented PATH. */
  installed: boolean;
  /** Absolute path of the resolved binary, when installed. */
  path: string | null;
  /** The independently declared usage surfaces this agent can populate.
   * Absent/empty = no usage contribution. */
  usageCapabilities?: readonly AgentUsageCapability[];
}

/** Agents to offer in the picker: installed only, but the full catalog when none
 *  are detected — never lock the user out of creating an agent ([F1]). */
export function selectableAgents(agents: AgentInfo[]): AgentInfo[] {
  const installed = agents.filter((a) => a.installed);
  return installed.length > 0 ? installed : agents;
}

/** Pick a sensible agent type from the selectable set: keep `preferred` if it's
 *  still selectable, else the first selectable, else `"claude"` (pre-load / empty). */
export function defaultAgentType(
  agents: AgentInfo[],
  preferred?: AgentType,
): AgentType {
  const pool = selectableAgents(agents);
  if (preferred && pool.some((a) => a.id === preferred)) return preferred;
  return pool[0]?.id ?? "claude";
}

/** Whether `type`'s catalog entry declares YOLO support — the single gate
 *  every creation surface consults before offering (or defaulting) the mode.
 *  Unknown/absent agents answer false: no toggle, and no armed pane, for an
 *  agent whose plugin can't honor it. */
export function agentSupportsYolo(
  agents: AgentInfo[],
  type: AgentType,
): boolean {
  return agents.find((a) => a.id === type)?.supportsYolo ?? false;
}

/** Whether `type`'s catalog entry declares remote support — the single gate
 *  the spawn dialog consults before offering the "Where: Remote" option.
 *  Unknown/absent agents answer false: no remote choice, so an agent that
 *  can't honor a target never gets one picked for it (mirrors YOLO). */
export function agentSupportsRemote(
  agents: AgentInfo[],
  type: AgentType,
): boolean {
  return agents.find((a) => a.id === type)?.supportsRemote ?? false;
}

/** The remote URI schemes `type`'s catalog entry declares, or null when the
 *  agent is local-only (no remote, or unknown agent). The spawn dialog
 *  validates a pasted endpoint's scheme against these — codex speaks ws/wss,
 *  opencode http/https, and a scheme the agent can't speak is rejected rather
 *  than crashing at spawn time. */
export function agentRemoteSchemes(
  agents: AgentInfo[],
  type: AgentType,
): readonly AgentRemoteScheme[] | null {
  const a = agents.find((x) => x.id === type);
  return a?.supportsRemote && a.remoteSchemes && a.remoteSchemes.length > 0
    ? a.remoteSchemes
    : null;
}
