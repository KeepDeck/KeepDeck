import {
  foldExhaustionAlerts,
  type ExhaustionAlerts,
} from "../domain/usage/exhaustionAlerts";
import type { AccountUsage } from "../domain/usage";
import type { NotifyInput } from "./notificationCenter";
import type { WindowReportsSnapshot } from "./windowReportJournal";

/**
 * Announces windows on pace to run out — the delivery shell around the
 * domain's [`foldExhaustionAlerts`]: every report-journal emit and a slow
 * clock tick (a forecast can turn critical purely by time passing) run one
 * fold; what it returns is notified, and nothing else is decided here.
 * An app-lifetime service owned by the runtime, shaped like
 * `achievementNotifier`: injected dependencies, tests build instances over
 * fakes.
 *
 * The alarm memory is process-local on purpose: a restart into a window
 * still burning hot re-announces it — an alarm is a CONDITION, unlike an
 * achievement, which is an event that must congratulate exactly once.
 */

export interface WindowExhaustionNotifierDeps {
  /** Resolves when user settings are loaded. The same race guard as the
   * achievement notifier: notify() falls back to DEFAULT prefs while
   * settings are in flight, and a boot alarm must not banner past a user
   * who disabled notifications. */
  settingsReady(): Promise<void>;
  /** Returns whether a delivery channel accepted it (see
   * [`notificationCenter.notify`]). */
  notify(input: NotifyInput): boolean;
  journal: {
    getSnapshot(): WindowReportsSnapshot;
    subscribe(listener: () => void): () => void;
  };
  usage: {
    getSnapshot(): { accounts: ReadonlyMap<string, AccountUsage> };
  };
  now?(): number;
}

/** The slow tick that catches time-driven edges (outAt drifting inside the
 * critical hour with no new report). One minute: far finer than the hour
 * threshold it guards, far coarser than render clocks. */
const FORECAST_TICK_MS = 60_000;

export function createWindowExhaustionNotifier(
  deps: WindowExhaustionNotifierDeps,
): { dispose(): void } {
  const now = deps.now ?? (() => Date.now());
  let alerts: ExhaustionAlerts = new Map();
  let ready = false;
  let disposed = false;

  const check = () => {
    if (disposed || !ready) return;
    const journal = deps.journal.getSnapshot();
    if (!journal.ready) return;
    const fold = foldExhaustionAlerts(
      alerts,
      deps.usage.getSnapshot().accounts,
      journal.byKey,
      now(),
    );
    const applied = new Map(fold.alerts);
    for (const notice of fold.notices) {
      const delivered = deps.notify({
        title: notice.title,
        body: notice.body,
        icon: "⏳",
        severity: "warning",
        // The click lands on the provider cards — the burn curves and the
        // full caption behind this alarm.
        source: { type: "stats", tab: "providers" },
        // Namespaced like every host tag (achievement:, pane:, app:) — the
        // raw journal key stays the DOMAIN identity; the tag is delivery's.
        tag: `exhaustion:${notice.key}`,
      });
      // Delivery accounting: rebuild the fold's memory minus the keys no
      // channel accepted, so the next fold retries them. This deliberately
      // edits the domain's record from the shell — delivery is the shell's
      // fact, and ExhaustionAlert is a single field, so the edit is
      // lossless. If the record ever grows, move this into the fold.
      if (!delivered) applied.delete(notice.key);
    }
    alerts = applied;
  };

  const unsubscribe = deps.journal.subscribe(check);
  const tick = setInterval(check, FORECAST_TICK_MS);
  void deps
    .settingsReady()
    .catch(() => undefined)
    .then(() => {
      if (disposed) return;
      ready = true;
      check();
    });

  return {
    dispose() {
      disposed = true;
      clearInterval(tick);
      unsubscribe();
    },
  };
}
