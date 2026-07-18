/** Coding-agent kind a pane runs — an OPEN set now: ids come from cli
 *  plugins' agent contributions (`keepdeck.claude` / `keepdeck.codex` /
 *  `keepdeck.opencode` ship built-in), so this is a plain string, not a
 *  union. A pane may carry an id whose plugin is currently absent — that
 *  pane must surface "agent unavailable", never silently run a default. */
export type AgentType = string;

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
  /** Whether the CLI resolves on the augmented PATH. */
  installed: boolean;
  /** Absolute path of the resolved binary, when installed. */
  path: string | null;
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

