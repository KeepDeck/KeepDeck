import { weekSpans } from "../domain/usage/stats/weekly";
import { HOUR_MS, localDayFromOrdinal, type LocalDayNumber } from "../domain/usage/time";
import { weeklyDigestView } from "../presentation/stats/weeklyView";
import type { NotifyInput } from "./notificationCenter";
import type { UsageHistorySnapshot } from "./usageHistoryManager";
import { isJsonRecord } from "@keepdeck/plugin-api";

/**
 * Tells the person, once a week, how the last week went — the Weekly tab's
 * own report of it, and a click that opens Weekly on that week. ONE digest
 * per finished week, never repeated: the week it last reported is
 * persisted, and a week with nothing in it is passed over in silence.
 *
 * An app-lifetime service owned by the runtime, like the achievement
 * notifier beside it — dependencies injected, so tests build their own
 * instance with fakes. It checks whenever the ledger changes and on an
 * hourly tick, so a Monday with no usage still gets last week's digest.
 */
export interface WeeklyDigestDeps {
  loadDigest(): Promise<string | null>;
  saveDigest(json: string): Promise<void>;
  /** Resolves when user settings are loaded: a delivery decision here is
   * persisted, so it must not race the user's notification preferences. */
  settingsReady(): Promise<void>;
  /** Returns whether a delivery channel accepted it. */
  notify(input: NotifyInput): boolean;
  history: {
    getSnapshot(): UsageHistorySnapshot;
    subscribe(listener: () => void): () => void;
  };
  now(): number;
  every(ms: number, tick: () => void): () => void;
}

/** The document names a week by its Monday's day ordinal — a calendar date,
 * the same week in any zone, where an instant moves with the clock. */
const DIGEST_VERSION = 2;

/** The week the last digest reported, from the persisted document — none
 * for a missing, unreadable or other-version one (at worst one repeat). */
function readLastWeek(json: string | null): LocalDayNumber | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!isJsonRecord(value) || value.version !== DIGEST_VERSION) return null;
    return localDayFromOrdinal(value.week);
  } catch {
    return null;
  }
}

export function createWeeklyDigestNotifier(deps: WeeklyDigestDeps): { dispose(): void } {
  /** Undefined until the persisted week loads; checks wait for it. */
  let lastWeek: LocalDayNumber | null | undefined;
  let disposed = false;
  let writes: Promise<void> = Promise.resolve();

  const record = (week: LocalDayNumber) => {
    lastWeek = week;
    const json = JSON.stringify({ version: DIGEST_VERSION, week });
    writes = writes
      .catch(() => {})
      .then(() => deps.saveDigest(json))
      // Best-effort: a failed save means at worst a repeated digest.
      .catch(() => {});
  };

  const check = () => {
    if (disposed || lastWeek === undefined) return;
    const snapshot = deps.history.getSnapshot();
    // A partial history would report a week short of what it spent.
    if (!snapshot.ready || !snapshot.complete) return;
    const now = deps.now();
    const due = weekSpans(now, 1).monday;
    if (lastWeek !== null && lastWeek >= due) return;
    const digest = weeklyDigestView(snapshot.ledger.events, now);
    if (digest === null) {
      record(due);
      return;
    }
    const delivered = deps.notify({
      title: digest.title,
      body: digest.body,
      source: { type: "stats", tab: "weekly", week: digest.week },
      tag: `digest:${digest.week}`,
    });
    // An undelivered digest (notifications off) stays due — turning them
    // back on tells it rather than losing it.
    if (delivered) record(due);
  };

  const unsubscribe = deps.history.subscribe(check);
  const stopTicking = deps.every(HOUR_MS, check);
  void Promise.all([deps.loadDigest().catch(() => null), deps.settingsReady()]).then(([json]) => {
    if (disposed) return;
    lastWeek = readLastWeek(json);
    check();
  });

  return {
    dispose() {
      disposed = true;
      unsubscribe();
      stopTicking();
    },
  };
}
