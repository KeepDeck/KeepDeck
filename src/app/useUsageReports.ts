import { useEffect } from "react";
import { log } from "../ipc/log";
import { onUsageReport } from "../ipc/usage";
import { reportUsage } from "./usageManager";
import { peekPaneSpawnSpec } from "./spawnSpecs";
import { postbackAccepted } from "./useSessionBinding";

/** The bridge → store lane: apply usage reports that echo the secret the
 * pane's own spawn carried (the session-binding rule); everything else is
 * logged and dropped. */
export function useUsageReports(): void {
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
}
