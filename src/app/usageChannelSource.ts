import type { AgentUsage } from "@keepdeck/plugin-api";
import type { DeckStore } from "./deckStore";
import type { PaneAttribution } from "./paneAttribution";
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
  declarations: UsageDeclarations;
  /** The runtime's usage store — every lane writes through this value. */
  usage: UsageManager;
}
