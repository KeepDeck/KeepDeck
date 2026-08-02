import { windowLabel, windowResetCaption } from "./format";
import { INSTANCE_JUMP_MS, type WindowReport } from "./reportJournal";
import type { AccountUsage } from "./usage";
import { accountWindowForecasts, runOutCountdown } from "./windowForecast";

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
 * read off the WINDOW REPORT'S OWN VALUES fold over fold — a reset instant
 * that jumps forward past jitter ([`INSTANCE_JUMP_MS`], the journal's own
 * boundary rule), or a balance refilled well below the alarm-era peak.
 * Deliberately NOT the journal's segment slice: retention pruning moves a
 * segment's head mid-instance (one alarm PER REPORT on an aged plan-window
 * journal), and a 1–2pp cross-pane correction restarts a segment without
 * any reset — both turned one alarm into a drumbeat. Held records track
 * the drifting reset and the rising peak, so identity compares one fold's
 * STEP, never an accumulation. */
export interface ExhaustionAlert {
  resetsAt: number | null;
  peakUsedPct: number;
}

/** A drop from the alarm-era peak this deep is a refill/top-up — a NEW
 * allowance worth a fresh alarm. Deeper than the journal's 1pp segment
 * boundary on purpose: segmentation protects pace math and wants every
 * dip; re-arming faces the user and must shrug off cross-pane corrections
 * (~1–2pp in the field). Any real top-up moves far more than this. */
const REFILL_DROP_PCT = 5;

export type ExhaustionAlerts = ReadonlyMap<string, ExhaustionAlert>;

export interface ExhaustionNotice {
  /** The window's journal key — the alarm's identity. The delivery shell
   * namespaces it into the notification tag. */
  key: string;
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
    // Non-reported accounts yield an empty join — the kind guard is the
    // join's, not re-stated here.
    const rows = accountWindowForecasts(agent, account, byKey, now);
    for (const row of rows.values()) {
      const fired = prev.get(row.key);
      const window = row.window;
      // Did THIS fold's step end the fired instance? A reset jumping past
      // jitter, or the balance refilled well under the alarm-era peak.
      const newInstance =
        fired !== undefined &&
        ((fired.resetsAt !== null &&
          window.resetsAt !== null &&
          window.resetsAt > fired.resetsAt + INSTANCE_JUMP_MS) ||
          window.usedPct < fired.peakUsedPct - REFILL_DROP_PCT);
      const forecast = row.forecast;
      if (
        forecast.kind === "out" &&
        forecast.level === "critical" &&
        (fired === undefined || newInstance)
      ) {
        notices.push({
          key: row.key,
          // The one run-out phrase, composed for a notification — the
          // alarm never invents a second wording for the fact.
          title: `${agent} ${windowLabel(window, "long")} window ${
            runOutCountdown(forecast.outAt, now)
          }`,
          body: windowResetCaption(window, now, "long"),
        });
        alerts.set(row.key, {
          resetsAt: window.resetsAt ?? null,
          peakUsedPct: window.usedPct,
        });
      } else if (fired !== undefined && !newInstance && forecast.kind !== "ok") {
        // Re-anchor to the CURRENT values: sub-jitter drift and rising
        // usage must never accumulate into a false instance change.
        alerts.set(row.key, {
          resetsAt: window.resetsAt ?? null,
          peakUsedPct: Math.max(fired.peakUsedPct, window.usedPct),
        });
      }
      // Anything else drops the memory: a real recovery, or an instance
      // the alarm outlived while the pace is not critical (the next
      // critical then fires fresh). Keys absent from the accounts drop
      // implicitly — an account returning still-critical earns a fresh
      // alarm.
    }
  }
  return { alerts, notices };
}
