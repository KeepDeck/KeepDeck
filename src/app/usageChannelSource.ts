import type { AgentUsage, TailWatch } from "@keepdeck/plugin-api";
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
  /** What an agent's plugin asked to have carried out of its session store,
   * when it declared a tail dialect. Handed to the follower verbatim: the
   * side that reads the bytes applies it without reading it. Absent for an
   * agent whose plugin has not declared one. */
  watchOf(agentId: string): TailWatch | undefined;
}
