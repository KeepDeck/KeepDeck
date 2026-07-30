import type { AgentUsage } from "@keepdeck/plugin-api";
import type { DeckStore } from "./deckStore";

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
}
