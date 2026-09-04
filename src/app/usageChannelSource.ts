import type { AgentUsage, SessionTailDialect } from "@keepdeck/plugin-api";
import type { DeckStore } from "./deckStore";
import type { PaneAttribution } from "./paneAttribution";
import type { SessionBinding } from "./sessionBinding";
import type { UsageManager } from "./usageManager";

export interface UsageDeclarations {
  current(): ReadonlyMap<string, AgentUsage>;
  subscribe(listener: () => void): () => void;
}

export interface UsageLane {
  dispose(): void;
}

export interface UsageLaneContext {
  deck: DeckStore;
  /** Who may report for a pane — shared with every other bridge lane so the
   * three cannot reach different answers. */
  attribution: PaneAttribution;
  /** The bindings the session lane ACCEPTED. Lanes that need to know a pane
   * bound take them from here rather than re-judging the raw event, because
   * the verdict is stateful and must be reached once per report. */
  bindings: SessionBinding;
  declarations: UsageDeclarations;
  /** The runtime's usage store — every lane writes through this value. */
  usage: UsageManager;
  /** The agent's own dialect for its live store, when its plugin declared
   * one. Two things come from it and nothing else does: WHICH store to
   * follow, which the dialect may have to go and find, and WHAT to carry out
   * of it, which is handed to the follower verbatim and applied without
   * being read. Absent for an agent whose plugin has not declared one. */
  tailOf(agentId: string): SessionTailDialect<never, never> | undefined;
}
