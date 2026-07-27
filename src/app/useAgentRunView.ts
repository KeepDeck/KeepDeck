import { useSyncExternalStore } from "react";
import type { AgentOrchestrator, AgentRunView } from "./agentOrchestrator";

/**
 * Read what the orchestrator has to say about panes that are not running —
 * the blocked directories and the refused resumes the cards explain.
 *
 * A subscription and nothing else. The decisions, the probes and the deck
 * transitions belong to [`AgentOrchestrator`], which runs whether or not any
 * of this is on screen.
 */
export function useAgentRunView(
  orchestrator: AgentOrchestrator,
): AgentRunView {
  return useSyncExternalStore(
    orchestrator.subscribe,
    orchestrator.getView,
    orchestrator.getView,
  );
}
