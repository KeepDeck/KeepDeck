import { isJsonRecord } from "@keepdeck/plugin-api";
import { log } from "../ipc/log";
import { onCompanionHello } from "../ipc/companions";
import type { DeckWatch } from "./deckStore";
import type { PaneAttribution } from "./paneAttribution";
import {
  createVerifiedPaneReports,
  type PaneReportEvent,
  type VerifiedPaneReports,
} from "./verifiedPaneReports";

/**
 * The bridge lane for companion hellos — a reporter inside the agent process
 * (a mod, a CLI plugin) announcing itself once. Verified exactly like every
 * other report: the pane's secret, the pane's agent, the pane's process, a
 * live process. What the hello means is the attribution ledger's to keep
 * ([`PaneAttribution.hasCompanion`]); this lane only admits it.
 *
 * A hello that cannot name its process is dropped: a companion nobody can
 * place could only ever count for the wrong one.
 */
export function listenPaneCompanions(
  deck: DeckWatch,
  attribution: PaneAttribution,
  subscribe: (handler: (report: PaneReportEvent) => void) => Promise<() => void> =
    onCompanionHello,
): VerifiedPaneReports {
  return createVerifiedPaneReports(deck, attribution, {
    label: "companion hello",
    subscribe,
    requireLiveProcess: true,
    apply(paneId, payload) {
      const reporter =
        isJsonRecord(payload) && typeof payload.reporter === "string" && payload.reporter
          ? payload.reporter
          : undefined;
      if (reporter === undefined) {
        log.warn("web:bridge", `companion hello for ${paneId} names no process — ignored`);
        return;
      }
      attribution.recordCompanion(paneId, reporter);
    },
  });
}
