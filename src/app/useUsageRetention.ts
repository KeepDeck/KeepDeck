import { useEffect } from "react";
import { paneMembership, paneMembershipKey } from "./paneMembership";
import { retainUsagePanes } from "./usageManager";
import type { Deck } from "./useDeck";

/** Store hygiene: drop pane usage for panes that left the deck. Account
 * chips deliberately survive their reporter — the windows describe the
 * account, not the pane. */
export function useUsageRetention(deck: Deck): void {
  const paneIds = paneMembershipKey(deck);
  useEffect(() => {
    retainUsagePanes(paneMembership(paneIds));
  }, [paneIds]);
}
