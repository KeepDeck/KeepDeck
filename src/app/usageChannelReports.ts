import { onUsageReport } from "../ipc/usage";
import type { UsageLane, UsageLaneContext } from "./usageChannelSource";
import { createVerifiedPaneReports } from "./verifiedPaneReports";

/** Bridge reports into the usage store through the shared verification —
 * membership and token only: usage describes the session and account, which
 * outlive the process, so a tail's final token_count after a crash still
 * counts. */
export function createUsageReportsLane({
  deck,
  usage,
  attribution,
}: UsageLaneContext): UsageLane {
  return createVerifiedPaneReports(deck, attribution, {
    label: "usage report",
    subscribe: onUsageReport,
    apply: (paneId, payload) => usage.report(paneId, payload),
  });
}
