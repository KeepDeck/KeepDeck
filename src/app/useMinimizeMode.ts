import { useEffect } from "react";
import type { DeckLayout, MinimizeStyle } from "../domain/settings";
import type { Deck } from "./useDeck";

type MinimizeDeck = Pick<Deck, "viewByWs" | "clearMinimized">;

/**
 * Own the application rule between the durable minimize preference and the
 * deck's session-only minimized sets. List layout merely masks those sets;
 * choosing None disables the feature and therefore clears them everywhere.
 */
export function useMinimizeMode(
  deckLayout: DeckLayout,
  minimizeStyle: MinimizeStyle,
  deck: MinimizeDeck,
): boolean {
  const minimizeOn = deckLayout === "grid" && minimizeStyle !== "none";
  const hasMinimized = Object.values(deck.viewByWs).some(
    (view) => (view.minimized?.length ?? 0) > 0,
  );

  useEffect(() => {
    if (minimizeStyle === "none" && hasMinimized) deck.clearMinimized();
  }, [deck.clearMinimized, hasMinimized, minimizeStyle]);

  return minimizeOn;
}
