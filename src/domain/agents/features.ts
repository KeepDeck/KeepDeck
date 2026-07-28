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
