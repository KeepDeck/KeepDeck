import { windowLabel, windowResetCaption } from "./format";
import type { WindowReport } from "./reportJournal";
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
 * memory re-arms when the window INSTANCE ends (its reset anchor moves) or
 * the pace genuinely recovers to `ok` — never on `unknown`, so a data gap
 * (the stale belt, a silent stream) cannot turn one long alarm into a
 * drumbeat. `warn` after a fired alarm holds it too: the countdown
 * de-escalating is not a recovery.
 */

/** The fired memory per window key: the instance (its reset anchor) the
 * alarm sounded for. */
export interface ExhaustionAlert {
  resetsAt: number | null;
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
      const resetsAt = row.window.resetsAt ?? null;
      const critical =
        row.forecast.kind === "out" && row.forecast.level === "critical";
      if (critical && (fired === undefined || fired.resetsAt !== resetsAt)) {
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
        alerts.set(row.key, { resetsAt });
      } else if (
        fired !== undefined &&
        fired.resetsAt === resetsAt &&
        row.forecast.kind !== "ok"
      ) {
        alerts.set(row.key, fired);
      }
      // Anything else drops the memory: a real recovery, or an instance
      // the alarm outlived. Keys absent from the accounts drop implicitly
      // — an account returning still-critical earns a fresh alarm.
    }
  }
  return { alerts, notices };
}
