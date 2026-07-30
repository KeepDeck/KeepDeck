import type { DeckLayout, MinimizeStyle } from "../domain/settings";

/**
 * Visual projection of the durable minimize preference. Reconciliation of
 * manual minimized state is owned by the runtime-level minimize policy.
 */
export function useMinimizeMode(
  deckLayout: DeckLayout,
  minimizeStyle: MinimizeStyle,
): boolean {
  return deckLayout === "grid" && minimizeStyle !== "none";
}
