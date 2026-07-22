import { useEffect, useRef } from "react";
import { log } from "../ipc/log";
import { onUsageReport } from "../ipc/usage";
import { paneMembership, paneMembershipKey } from "./paneMembership";
import { reportUsage } from "./usageManager";
import { peekPaneSpawnSpec } from "./spawnSpecs";
import { postbackAccepted } from "./useSessionBinding";
import type { Deck } from "./useDeck";

/** The bridge → store lane: apply usage reports that echo the secret the
 * pane's own spawn carried (the session-binding rule); everything else is
 * logged and dropped. */
export function useUsageReports(deck: Deck): void {
  const livePanes = useRef<ReadonlySet<string>>(new Set());
  livePanes.current = paneMembership(paneMembershipKey(deck));

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onUsageReport(({ paneId, token, payload }) => {
      if (!livePanes.current.has(paneId)) {
        log.warn("web:bridge", `usage report for closed pane ${paneId} — ignored`);
        return;
      }
      if (!postbackAccepted(peekPaneSpawnSpec(paneId), token)) {
        log.warn(
          "web:bridge",
          `usage report for ${paneId} with a wrong token — ignored`,
        );
        return;
      }
      reportUsage(paneId, payload);
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
