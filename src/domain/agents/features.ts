/** Host-side structural twin of a manifest CLI feature. The manifest remains
 * the authoring source; this shape is only its in-memory projection. */
export interface AgentFeature {
  id: string;
  label: string;
  group?: string;
  description?: string;
  parameters?: Readonly<Record<string, AgentFeatureParameter>>;
}

export type AgentFeatureParameter =
  | string
  | number
  | boolean
  | null
  | readonly (string | number | boolean | null)[];

/** Semantic ids consumed by existing host behavior. This is not a support
 * matrix: each plugin's manifest is the only place that declares support. */
export const AGENT_FEATURE = {
  newSession: "session.new",
  resumeSession: "session.resume",
  forkSession: "session.fork",
  sessionHistory: "session.history",
  paneUsage: "usage.pane",
  accountUsage: "usage.account",
  yolo: "execution.yolo",
  remoteTarget: "target.remote",
  /** The agent receives the library's MCP servers at its next session —
   * through a file in its cwd when the declaration says `delivery: "cwd"`
   * ([`deliversMcpByCwd`]). */
  mcpServers: "integration.mcp",
  /** The agent receives the library's skills at its next session. */
  skills: "integration.skills",
} as const;

export function findAgentFeature(
  features: readonly AgentFeature[],
  id: string,
): AgentFeature | null {
  return features.find((feature) => feature.id === id) ?? null;
}

export function hasAgentFeature(
  features: readonly AgentFeature[],
  id: string,
): boolean {
  return findAgentFeature(features, id) !== null;
}

/** Whether an agent takes its MCP servers through a file in its cwd — what
 * its plugin declares, never a name the host knows. Such a file is ONE per
 * folder, so a folder two panes share cannot carry a per-pane secret. */
export function deliversMcpByCwd(features: readonly AgentFeature[]): boolean {
  return findAgentFeature(features, AGENT_FEATURE.mcpServers)?.parameters?.delivery === "cwd";
}
