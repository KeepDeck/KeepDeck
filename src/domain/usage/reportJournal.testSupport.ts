import { TEST_NOW } from "./history/event.testSupport";
import type { WindowReport } from "./reportJournal";
import type { UsageWindow } from "./usage";

/** THE window-report builder — replaces the hand-copied builders whose
 * defaults had already drifted across four test files (usedPct 40 vs 10,
 * reportedAt −20m vs −30m, sourcePaneId "p" vs "pane-1"). One default set;
 * a file with different needs overrides per call, visibly. */
export const windowReport = (
  over: Partial<WindowReport> = {},
): WindowReport => ({
  agent: "claude",
  windowMinutes: 300,
  usedPct: 10,
  reportedAt: TEST_NOW - 30 * 60_000,
  resetsAt: TEST_NOW + 155 * 60_000,
  ...over,
});

/** The canonical alarm-fixture window the report defaults describe: a 5h
 * window at 88% with 2h35m to its reset. */
export const FIVE_H: UsageWindow = {
  usedPct: 88,
  resetsAt: TEST_NOW + 155 * 60_000,
  windowMinutes: 300,
};

export { TEST_NOW } from "./history/event.testSupport";
