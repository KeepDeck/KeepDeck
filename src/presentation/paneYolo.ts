import type { AgentPermissionMode } from "@keepdeck/plugin-api";

/** What is known of how freely a pane's agent acts, from the freshest source
 * to the stalest. */
export interface PaneYoloFacts {
  /** The mode the agent last said it runs in; null until it says. */
  said: AgentPermissionMode | null;
  /** Whether its process was launched in YOLO, per its plan; null while the
   * pane has no plan behind it. */
  launched: boolean | null;
  /** Whether YOLO was asked for when the pane was made. */
  asked: boolean;
}

/** What the deck itself knows: how the pane was launched and asked to run —
 * everything but the agent's own word. */
export type PaneYoloStart = Omit<PaneYoloFacts, "said">;

/** A pane nobody asked to run in YOLO, with no plan yet. */
export const NOT_ASKED_YOLO: PaneYoloStart = { launched: null, asked: false };

/** A pane's [`PaneYoloStart`] from its request and its plan, when it has one. */
export function paneYoloStart(asked: boolean | undefined, plan: { yolo?: boolean } | undefined): PaneYoloStart {
  return { launched: plan ? plan.yolo === true : null, asked: asked === true };
}

/**
 * Whether the pane wears the YOLO badge: the agent's own word once it has
 * said one — a policy that refused YOLO or the user leaving it inside the CLI
 * included — else what its process was launched with, and only for a pane
 * with no plan yet, what it was asked for.
 */
export function paneRunsYolo({ said, launched, asked }: PaneYoloFacts): boolean {
  if (said !== null) return said === "yolo";
  if (launched !== null) return launched;
  return asked;
}
