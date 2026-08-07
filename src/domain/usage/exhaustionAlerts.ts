import { windowLabel, windowResetCaption } from "./format";
import { instanceChanged, type WindowReport } from "./reportJournal";
import type { AccountUsage } from "./usage";
import { accountWindowForecasts, runOutPhrase } from "./windowForecast";

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
 * read off the WINDOW REPORT'S OWN VALUES fold over fold, and judged by the
 * journal's own [`instanceChanged`] at this file's coarser drop threshold.
 * Deliberately NOT the journal's segment slice: retention pruning moves a
 * segment's head
 * mid-instance (one alarm PER REPORT on an aged plan-window journal), and
 * a 1–2pp cross-pane correction restarts a segment without any reset —
 * both turned one alarm into a drumbeat. BOTH fields re-anchor to the
 * current report on every fold that keeps the record, so identity always
 * compares one fold's STEP and neither drift nor a slow decline can
 * accumulate into a false instance change. */
export interface ExhaustionAlert {
  resetsAt: number | null;
  usedPct: number;
}

/** How deep a single-step fall counts as a refill when the window has no
 * reset instant to go by — a NEW allowance worth a fresh alarm; a real
 * top-up lands as one report, so its whole depth arrives in one fold step.
 * Deeper than the journal's 1pp on purpose: re-arming faces the user and
 * must shrug off cross-pane corrections (~1–2pp in the field).
 *
 * It is only a THRESHOLD. The rule itself — that a fall means nothing once
 * both sides name the same reset instant — lives in `instanceChanged`, and
 * this file used to carry its own copy without that guard. The consequence
 * was reachable and ugly: the exact quantisation outlier the journal had
 * just learned to ignore still re-armed the alarm, so one bad reading meant
 * a second banner for the same window with the countdown going UP. */
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
      // jitter, or the balance refilled in one deep drop. (The window
      // values and the forecast stay coherent because the journal captures
      // synchronously with every usage-store update — accounts are never
      // ahead of the series a fold reads.)
      const newInstance =
        fired !== undefined &&
        instanceChanged(fired, window, REFILL_DROP_PCT);
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
            runOutPhrase(forecast.outAt, now, "join")
          }`,
          body: windowResetCaption(window, now, "long"),
        });
        alerts.set(row.key, {
          resetsAt: window.resetsAt ?? null,
          usedPct: window.usedPct,
        });
        // Everything the old `!== "ok"` covered: the window has not been
        // shown to survive, so the alarm stays armed and its memory has to
        // keep up with the values it will next be compared against.
      } else if (
        fired !== undefined &&
        !newInstance &&
        forecast.kind !== "lasts" &&
        forecast.kind !== "idle"
      ) {
        // Re-anchor BOTH values: neither sub-jitter drift nor a slow
        // decline may accumulate into a false instance change.
        alerts.set(row.key, {
          resetsAt: window.resetsAt ?? null,
          usedPct: window.usedPct,
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
