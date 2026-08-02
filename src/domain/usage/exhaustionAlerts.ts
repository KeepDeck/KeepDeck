import { windowLabel, windowResetCaption } from "./format";
import { currentSegment, type WindowReport } from "./reportJournal";
import type { AccountUsage } from "./usage";
import { accountWindowForecasts, panelWindowCaption } from "./windowForecast";

/**
 * The exhaustion-alarm policy — WHEN a window's forecast deserves a
 * notification, and its exact wording. A pure fold: the app-layer notifier
 * feeds it the two snapshots and a clock, delivers what it returns, and
 * keeps no rules of its own.
 *
 * An alarm is an EDGE, not a level: entering `critical` (imminent run-out
 * on live data) notifies once; holding critical stays silent. The fired
 * memory re-arms when the window INSTANCE ends or the pace genuinely
 * recovers to `ok` — never on `unknown`, so a data gap (the stale belt, a
 * silent stream) cannot turn one long alarm into a drumbeat. `warn` after
 * a fired alarm holds it too: a de-escalated countdown is not a recovery.
 */

/** The fired memory per window key: the instance the alarm sounded for,
 * identified the journal's own way — the first report of the window's
 * current segment ([`currentSegment`]). `resetsAt` was the WRONG identity:
 * clockless plan windows (kimi's quota) carry null forever, so a topped-up
 * balance burning hot again could never re-alarm, while a sub-jitter reset
 * drift the journal treats as the SAME instance would re-fire a duplicate.
 * The anchor can outrun a fired memory only when retention prunes the
 * segment's head mid-instance — for rate windows retention is 1.5 window
 * lengths, so the instance is over first; for plan windows that costs at
 * worst one repeated (tag-replaced) alarm a week. */
export interface ExhaustionAlert {
  anchor: number;
}

export type ExhaustionAlerts = ReadonlyMap<string, ExhaustionAlert>;

export interface ExhaustionNotice {
  /** The window's journal key — doubles as the notification tag, so a
   * re-fired alarm replaces its predecessor instead of stacking. */
  key: string;
  agent: string;
  title: string;
  body: string;
}

export function foldExhaustionAlerts(
  prev: ExhaustionAlerts,
  accounts: ReadonlyMap<string, AccountUsage>,
  byKey: ReadonlyMap<string, readonly WindowReport[]>,
  now: number,
): { alerts: ExhaustionAlerts; notices: ExhaustionNotice[] } {
  const alerts = new Map<string, ExhaustionAlert>();
  const notices: ExhaustionNotice[] = [];
  for (const [agent, account] of accounts) {
    if (account.kind !== "reported") continue;
    const rows = accountWindowForecasts(agent, account, byKey, now);
    for (const row of rows.values()) {
      const fired = prev.get(row.key);
      const segment = currentSegment(row.reports);
      const anchor = segment.length > 0 ? segment[0].reportedAt : null;
      const critical =
        row.forecast.kind === "out" && row.forecast.level === "critical";
      if (
        critical &&
        anchor !== null &&
        (fired === undefined || fired.anchor !== anchor)
      ) {
        notices.push({
          key: row.key,
          agent,
          // The popover's own next-event phrasing carries the alarm — the
          // notification never invents a second wording for one fact.
          title: `${agent} ${windowLabel(row.window, "long")} window ${
            panelWindowCaption(row.window, row.forecast, now).text
          }`,
          body: windowResetCaption(row.window, now, "long"),
        });
        alerts.set(row.key, { anchor });
      } else if (
        fired !== undefined &&
        fired.anchor === anchor &&
        row.forecast.kind !== "ok"
      ) {
        alerts.set(row.key, fired);
      }
      // Anything else drops the memory: a real recovery, a new segment the
      // alarm outlived, or a series pruned away whole. Keys absent from the
      // accounts drop implicitly — an account returning still-critical
      // earns a fresh alarm.
    }
  }
  return { alerts, notices };
}
