import type { Deck } from "./useDeck";

/** One string key for the deck's pane MEMBERSHIP — stable across renders,
 * changed only when panes appear or disappear. Shared by the usage lanes
 * that key their sweeps on membership (tail teardown, store retention), so
 * "what counts as a member" can never drift between them. */
export function paneMembershipKey(deck: Deck): string {
  return deck.workspaces
    .flatMap((ws) => ws.panes.map((pane) => pane.id))
    .sort()
    .join("\n");
}

/** The member ids a key encodes. */
export function paneMembership(key: string): Set<string> {
  return new Set(key.split("\n").filter(Boolean));
}
