import {
  decodeWindowReport,
  encodeWindowReport,
  pruneReports,
  shouldRecord,
  windowReportKey,
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

export interface WindowReportJournalDeps {
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
      for (const window of account.windows) {
        const next: WindowReport = {
          agent,
          windowMinutes: window.windowMinutes ?? null,
          ...(window.scope !== undefined ? { scope: window.scope } : {}),
          usedPct: window.usedPct,
          reportedAt: account.reportedAt,
          resetsAt: window.resetsAt ?? null,
        };
        const key = windowReportKey(agent, window);
        const kept = byKey.get(key);
        const last = kept?.[kept.length - 1];
        if (!shouldRecord(last, next)) continue;
        // Copy-on-write: consumers memoize on the array's identity.
        byKey.set(key, kept ? [...kept, next] : [next]);
        lines.push(encodeWindowReport(next));
      }
    }
    if (lines.length > 0) {
      queueAppend(lines);
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
          const key = windowReportKey(report.agent, report);
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
      });
    return initialization;
  };

  return {
    start() {
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
