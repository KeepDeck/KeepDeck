import { isJsonRecord } from "@keepdeck/plugin-api";
import { stripUnsafeText } from "@keepdeck/plugin-api/unsafe-text";
import { log } from "../ipc/log";
import { onCompanionDeclined, onCompanionHello } from "../ipc/companions";
import type { DeckWatch } from "./deckStore";
import type { PaneAttribution } from "./paneAttribution";
import {
  createVerifiedPaneReports,
  type PaneReportEvent,
  type VerifiedPaneReports,
} from "./verifiedPaneReports";

type LaneSubscribe = (handler: (report: PaneReportEvent) => void) => Promise<() => void>;

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
  subscribe: LaneSubscribe = onCompanionHello,
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

/** The most of a declined wake's reason the log is given. claude's own run
 * to a sentence; the rest of a longer one is not a reason. */
const REASON_CHARS = 200;

/**
 * The bridge lane for declined wakes — a companion that took its pane's
 * doorbell down and whose agent would not start the turn it asked for.
 * Verified like the hello before it; what a decline MEANS is mail's
 * (`MailService.wakeDeclined`), and this lane only admits it.
 *
 * The reason is the agent's own words, written by the pane's process, so it
 * reaches the log as one clean, short line or not at all.
 */
export function listenCompanionDeclines(
  deck: DeckWatch,
  attribution: PaneAttribution,
  declined: (paneId: string, reason: string) => void,
  subscribe: LaneSubscribe = onCompanionDeclined,
): VerifiedPaneReports {
  return createVerifiedPaneReports(deck, attribution, {
    label: "declined wake",
    subscribe,
    requireLiveProcess: true,
    apply(paneId, payload) {
      const reason =
        isJsonRecord(payload) && typeof payload.reason === "string"
          ? stripUnsafeText(payload.reason).slice(0, REASON_CHARS)
          : "";
      declined(paneId, reason || "no reason given");
    },
  });
}
