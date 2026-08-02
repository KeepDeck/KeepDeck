import {
  accountWindowKeys,
  decodeWindowReport,
  encodeWindowReport,
  pruneReports,
  reportAlive,
  shouldRecord,
  storedReportKey,
  type WindowReport,
} from "../domain/usage/reportJournal";
import type { AccountUsage } from "../domain/usage";
import {
  appendUsageReports,
  compactUsageReports,
  loadUsageReports,
} from "../ipc/usageReports";
import { getUsageSnapshot, subscribeUsage } from "./usageManager";

export interface WindowReportsSnapshot {
  ready: boolean;
  /** Reports per window identity (see windowReportKey), reportedAt order. */
  byKey: ReadonlyMap<string, readonly WindowReport[]>;
}

interface WindowReportJournalDeps {
  ipc: {
    loadUsageReports(): Promise<string[]>;
    appendUsageReports(lines: string[]): Promise<void>;
    compactUsageReports(lines: string[]): Promise<void>;
  };
  usage: {
    getSnapshot(): { accounts: ReadonlyMap<string, AccountUsage> };
    subscribe(listener: () => void): () => void;
  };
  now?(): number;
}

/** The provider-report journal manager: watches the usage store and turns
 * every accepted account report into durable journal lines, applying the
 * domain's write policy (changes + heartbeats, never chatter). A factory —
 * the runtime owns the app instance, tests build their own over fakes. */
export function createWindowReportJournal(deps: WindowReportJournalDeps) {
  const now = deps.now ?? (() => Date.now());
  const byKey = new Map<string, WindowReport[]>();
  let snapshot: WindowReportsSnapshot = { ready: false, byKey: new Map() };
  const listeners = new Set<() => void>();
  let initialization: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;
  let writes: Promise<void> = Promise.resolve();
  let disposed = false;
  /** In-session retention: pruning trims memory on every append; the FILE
   * is rewritten only once enough dead lines accumulate. */
  let prunedSinceCompact = 0;
  const COMPACT_AFTER_PRUNED = 256;

  const emit = () => {
    snapshot = { ready: true, byKey: new Map(byKey) };
    for (const listener of [...listeners]) listener();
  };

  const queueAppend = (lines: string[]) => {
    writes = writes
      .catch(() => {})
      .then(() => deps.ipc.appendUsageReports(lines))
      // Best-effort: a failed append costs pace history, never the app.
      .catch(() => {});
  };

  /** Fold the CURRENT usage snapshot into the journal — one candidate per
   * reported window, filtered by the domain's write policy. */
  const capture = () => {
    if (disposed || !snapshot.ready) return;
    const lines: string[] = [];
    for (const [agent, account] of deps.usage.getSnapshot().accounts) {
      if (account.kind !== "reported") continue;
      const keys = accountWindowKeys(agent, account.windows);
      for (const window of account.windows) {
        const next: WindowReport = {
          agent,
          windowMinutes: window.windowMinutes ?? null,
          ...(window.scope !== undefined ? { scope: window.scope } : {}),
          usedPct: Math.min(100, Math.max(0, window.usedPct)),
          // A future-stamped report would poison the key forever (the
          // replay guard rejects everything after it) — clamp to now.
          reportedAt: Math.min(account.reportedAt, now()),
          resetsAt: window.resetsAt ?? null,
        };
        // A record already beyond its own retention (a cached account
        // restored hours later) must never enter the journal: pruning it
        // back out would leave an empty series whose replay guard has
        // nothing to stand on — the same line then re-appends forever.
        if (!reportAlive(next, now())) continue;
        const entry = keys.get(window)!;
        if (entry.ordinal !== null) next.ordinal = entry.ordinal;
        const key = entry.key;
        const kept = byKey.get(key);
        const last = kept?.[kept.length - 1];
        if (!shouldRecord(last, next)) continue;
        // Copy-on-write (consumers memoize on array identity), pruned as it
        // grows — retention is continuous, not a boot-only ceremony.
        const grown = kept ? [...kept, next] : [next];
        const trimmed = pruneReports(grown, now());
        prunedSinceCompact += grown.length - trimmed.length;
        byKey.set(key, trimmed);
        lines.push(encodeWindowReport(next));
      }
    }
    if (lines.length > 0) {
      queueAppend(lines);
      if (prunedSinceCompact >= COMPACT_AFTER_PRUNED) {
        prunedSinceCompact = 0;
        const survivors = [...byKey.values()].flat().map(encodeWindowReport);
        writes = writes
          .catch(() => {})
          .then(() => deps.ipc.compactUsageReports(survivors))
          .catch(() => {});
      }
      emit();
    }
  };

  const init = (): Promise<void> => {
    if (initialization) return initialization;
    initialization = deps.ipc
      .loadUsageReports()
      .then((loaded) => {
        if (disposed) return;
        let torn = false;
        for (const line of loaded) {
          const report = decodeWindowReport(line);
          if (!report) {
            torn = true;
            continue;
          }
          const key = storedReportKey(report);
          const kept = byKey.get(key);
          if (kept) kept.push(report);
          else byKey.set(key, [report]);
        }
        let pruned = false;
        for (const [key, reports] of byKey) {
          reports.sort((a, b) => a.reportedAt - b.reportedAt);
          const survivors = pruneReports(reports, now());
          if (survivors.length !== reports.length) {
            pruned = true;
            byKey.set(key, [...survivors]);
          }
        }
        if (torn || pruned) {
          const lines = [...byKey.values()].flat().map(encodeWindowReport);
          writes = writes
            .catch(() => {})
            .then(() => deps.ipc.compactUsageReports(lines))
            .catch(() => {});
        }
        emit();
        capture(); // the store may already hold reports from boot catch-up
      })
      .catch(() => {
        if (disposed) return;
        // An unreadable journal starts empty — pace returns with reports.
        emit();
        capture(); // same boot catch-up fold as the success path
      });
    return initialization;
  };

  return {
    start() {
      // Revivable: a start after dispose subscribes again instead of
      // silently producing a dead journal.
      disposed = false;
      unsubscribe ??= deps.usage.subscribe(capture);
      void init();
    },
    getSnapshot: (): WindowReportsSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

/** The app's one journal, wired to the real IPC and the live usage store.
 * The runtime starts and disposes it; the React hook consumes it. */
export const windowReportJournal = createWindowReportJournal({
  ipc: { loadUsageReports, appendUsageReports, compactUsageReports },
  usage: { getSnapshot: getUsageSnapshot, subscribe: subscribeUsage },
});
