import { useEffect } from "react";
import { retainUsagePanes } from "./usageManager";
import type { Deck } from "./useDeck";

/** Store hygiene: drop pane usage for panes that left the deck. Account
 * chips deliberately survive their reporter — the windows describe the
 * account, not the pane. */
export function useUsageRetention(deck: Deck): void {
  // A string key so the sweep runs only when pane MEMBERSHIP changes, not
  // on every deck render.
  const paneIds = deck.workspaces
    .flatMap((ws) => ws.panes.map((pane) => pane.id))
    .sort()
    .join("\n");
  useEffect(() => {
    retainUsagePanes(new Set(paneIds.split("\n").filter(Boolean)));
  }, [paneIds]);
}
