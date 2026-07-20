import { useRef } from "react";
import type { SpawnPlanContext } from "../domain/agents";
import type { Deck } from "./useDeck";

/**
 * The shared setup of the pane-orchestration hooks (restart, journal resume,
 * journal fork): live refs over the deck and spawn context — their flows
 * span awaits, so render-time props would go stale — plus the in-flight
 * guard set. Extracted because the race protocol is subtle concurrency code
 * repeated in three files: a protocol change must not be missable in one.
 */
export function useLiveRefs(deck: Deck, ctx: SpawnPlanContext | null) {
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const inFlight = useRef(new Set<string>());
  return { deckRef, ctxRef, inFlight };
}
