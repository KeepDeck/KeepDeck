import { useSyncExternalStore } from "react";
import { useRuntimePart } from "./runtimeContext";
import type { WindowReportsSnapshot } from "./windowReportJournal";

/** The provider-report journal, live — what the forecast surfaces read.
 * Off the runtime, like every store: the journal watches the runtime's
 * usage manager, so it lives beside it. */
export function useWindowReports(): WindowReportsSnapshot {
  const windowReportJournal = useRuntimePart("windowReportJournal");
  return useSyncExternalStore(
    windowReportJournal.subscribe,
    windowReportJournal.getSnapshot,
  );
}
