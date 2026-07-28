import {
  AGENT_FEATURE,
  findAgentFeature,
  hasAgentFeature,
  type AgentFeature,
} from "./features";

/** Coding-agent kind a pane runs — an OPEN set now: ids come from cli
 *  plugins' agent contributions (`keepdeck.claude` / `keepdeck.codex` /
 *  `keepdeck.opencode` ship built-in), so this is a plain string, not a
 *  union. A pane may carry an id whose plugin is currently absent — that
 *  pane must surface "agent unavailable", never silently run a default. */
export type AgentType = string;

/** The host-side structural twin of the plugin-api `RemoteScheme`. Kept local
 *  (no plugin-api import): data, not a contract reference. */
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
  /** Functional support projected from the plugin manifest. Runtime
   * contributions contain implementations only, never a parallel list. */
  features: readonly AgentFeature[];
  /** Whether this live contribution can feed usage to the host. Derived from
   * the implementation; readiness, not another support declaration. */
  usageAvailable?: boolean;
  /** Whether the CLI resolves on the augmented PATH. */
  installed: boolean;
  /** Absolute path of the resolved binary, when installed. */
  path: string | null;
}

/** Agents that can create a fresh pane. Within that launchable set, prefer
 * installed CLIs but keep the full set when none resolve ([F1]). */
export function selectableAgents(agents: AgentInfo[]): AgentInfo[] {
  const launchable = agents.filter((agent) =>
    hasAgentFeature(agent.features, AGENT_FEATURE.newSession),
  );
  const installed = launchable.filter((agent) => agent.installed);
  return installed.length > 0 ? installed : launchable;
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
  return agentHasFeature(agents, type, AGENT_FEATURE.yolo);
}

/** Whether `type` can create a fresh session. */
export function agentSupportsNew(
  agents: AgentInfo[],
  type: AgentType,
): boolean {
  return agentHasFeature(agents, type, AGENT_FEATURE.newSession);
}

export interface AgentSessionCapabilities {
  readonly history: boolean;
  readonly resume: boolean;
  readonly fork: boolean;
}

/** Session actions supported by one catalog entry. */
export function agentSessionCapabilities(
  agents: AgentInfo[],
  type: AgentType,
): AgentSessionCapabilities {
  const agent = agents.find((entry) => entry.id === type);
  const features = agent?.features ?? [];
  return {
    history: hasAgentFeature(features, AGENT_FEATURE.sessionHistory),
    resume: hasAgentFeature(features, AGENT_FEATURE.resumeSession),
    fork: hasAgentFeature(features, AGENT_FEATURE.forkSession),
  };
}

/** Whether `type`'s live integration can prepare a resume plan. */
export function agentSupportsResume(
  agents: AgentInfo[],
  type: AgentType,
): boolean {
  return agentSessionCapabilities(agents, type).resume;
}

export function agentSupportsFork(
  agents: AgentInfo[],
  type: AgentType,
): boolean {
  return agentSessionCapabilities(agents, type).fork;
}

export function agentHasFeature(
  agents: AgentInfo[],
  type: AgentType,
  featureId: string,
): boolean {
  const agent = agents.find((entry) => entry.id === type);
  return agent ? hasAgentFeature(agent.features, featureId) : false;
}

/** The remote URI schemes `type`'s catalog entry declares, or null when the
 *  agent is local-only (no remote, or unknown agent). The spawn dialog
 *  validates a pasted endpoint's scheme against these — codex speaks ws/wss,
 *  opencode http/https, and a scheme the agent can't speak is rejected rather
 *  than crashing at spawn time. This (not a separate supportsRemote boolean)
 *  is the single gate the dialog consults: a non-null answer both offers the
 *  "Where: Remote" option and constrains what endpoint it accepts. */
export function agentRemoteSchemes(
  agents: AgentInfo[],
  type: AgentType,
): readonly AgentRemoteScheme[] | null {
  const agent = agents.find((entry) => entry.id === type);
  if (!agent) return null;
  const feature = findAgentFeature(agent.features, AGENT_FEATURE.remoteTarget);
  const schemes = feature?.parameters?.schemes;
  if (!Array.isArray(schemes)) return null;
  const allowed = schemes.filter(isRemoteScheme);
  return allowed.length > 0 ? allowed : null;
}

function isRemoteScheme(value: unknown): value is AgentRemoteScheme {
  return (
    value === "ws" ||
    value === "wss" ||
    value === "http" ||
    value === "https"
  );
}

/** Whether `raw` is a usable remote-server endpoint for an agent that speaks
 *  `schemes`: parses as a URL, has a non-empty host, and its scheme is one the
 *  agent declares (codex ws/wss, opencode http/https). null/empty `schemes` =
 *  no remote support → always false. Pure so the gate stays unit-testable, and
 *  lives with the other dialog gates rather than in a component file. */
export function remoteValid(
  raw: string,
  schemes: readonly string[] | null,
): boolean {
  if (!schemes || schemes.length === 0) return false;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  const scheme = url.protocol.slice(0, -1); // "ws:" → "ws"
  return !!url.hostname && schemes.includes(scheme);
}
