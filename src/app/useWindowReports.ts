import { useSyncExternalStore } from "react";
import { useAppRuntime } from "./runtimeContext";
import type { WindowReportsSnapshot } from "./windowReportJournal";

/** The provider-report journal, live — what the forecast surfaces read.
 * Off the runtime, like every store: the journal watches the runtime's
 * usage manager, so it lives beside it. */
export function useWindowReports(): WindowReportsSnapshot {
  const { windowReportJournal } = useAppRuntime();
  return useSyncExternalStore(
    windowReportJournal.subscribe,
    windowReportJournal.getSnapshot,
  );
}
