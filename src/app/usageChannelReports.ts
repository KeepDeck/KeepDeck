import type { UsageCall } from "@keepdeck/plugin-api";
import { onUsageReport } from "../ipc/usage";
import type { UsageLane, UsageLaneContext } from "./usageChannelSource";
import { createVerifiedPaneReports } from "./verifiedPaneReports";

/** Where a verified report's calls and named stores go. */
export interface UsageReportRoutes {
  book(paneId: string, calls: readonly UsageCall[], sessionId?: string): void;
  link(paneId: string, ids: readonly string[]): void;
}

/** Bridge and tail reports into the usage store through the shared
 * verification — membership and token only: usage describes the session and
 * account, which outlive the process, so a tail's final record after a crash
 * still counts. The pane's live state lands in the store; the calls it made
 * go to the call book, and the stores it names to the tail. */
export function createUsageReportsLane(
  { deck, usage, attribution }: UsageLaneContext,
  routes: UsageReportRoutes,
): UsageLane {
  return createVerifiedPaneReports(deck, attribution, {
    label: "usage report",
    subscribe: onUsageReport,
    apply: (paneId, payload) => {
      const carried = usage.report(paneId, payload);
      if (carried?.calls?.length) routes.book(paneId, carried.calls, carried.sessionId);
      if (carried?.links?.length) routes.link(paneId, carried.links);
    },
  });
}
