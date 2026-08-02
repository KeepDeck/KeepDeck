import type { AgentUsage } from "@keepdeck/plugin-api";
import type { DeckStore } from "./deckStore";
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
  declarations: UsageDeclarations;
  /** The runtime's usage store — every lane writes through this value. */
  usage: UsageManager;
}
