/** Coding-agent kind a workspace runs in its panes. */
export type AgentType = "claude" | "opencode" | "codex";

interface AgentTypeInfo {
  id: AgentType;
  label: string;
  /** The CLI command spawned in the pane (no install check — fails in-pane). */
  command: string;
}

export const AGENT_TYPES: AgentTypeInfo[] = [
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "opencode", label: "opencode", command: "opencode" },
  { id: "codex", label: "Codex", command: "codex" },
];

/** The CLI command for an agent type. */
export function commandForAgent(type: AgentType): string {
  return AGENT_TYPES.find((a) => a.id === type)?.command ?? "claude";
}
