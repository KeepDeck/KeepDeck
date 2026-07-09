/** Coding-agent kind a pane runs — an OPEN set now: ids come from cli
 *  plugins' agent contributions (`keepdeck.claude` / `keepdeck.codex` /
 *  `keepdeck.opencode` ship built-in), so this is a plain string, not a
 *  union. A pane may carry an id whose plugin is currently absent — that
 *  pane must surface "agent unavailable", never silently run a default. */
export type AgentType = string;

/** An agent from the catalog (a cli plugin's contribution annotated with
 *  install detection). */
export interface AgentInfo {
  id: AgentType;
  label: string;
  /** CLI command to spawn (passed back to `session_spawn`). */
  command: string;
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

