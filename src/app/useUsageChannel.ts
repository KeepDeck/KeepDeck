import { useEffect } from "react";
import { log } from "../ipc/log";
import { onUsageReport } from "../ipc/usage";
import { reportUsage, retainUsagePanes } from "./usageManager";
import { peekPaneSpawnSpec } from "./spawnSpecs";
import { postbackAccepted } from "./useSessionBinding";
import type { Deck } from "./useDeck";

/**
 * The single mount point wiring bridge usage reports into the usage store —
 * one subscription per app (the store is a singleton; `useUsage` readers
 * mount freely, this hook must not). Verification mirrors the session
 * binding: a report counts only when it echoes the secret the pane's own
 * spawn carried. The companion effect prunes pane usage when panes close;
 * account chips deliberately survive their reporter.
 */
export function useUsageChannel(deck: Deck): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onUsageReport(({ paneId, token, payload }) => {
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

  // A string key so the retain sweep runs only when pane MEMBERSHIP changes,
  // not on every deck render.
  const paneIds = deck.workspaces
    .flatMap((ws) => ws.panes.map((pane) => pane.id))
    .sort()
    .join("\n");
  useEffect(() => {
    retainUsagePanes(new Set(paneIds.split("\n").filter(Boolean)));
  }, [paneIds]);
}
