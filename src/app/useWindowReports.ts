import { useSyncExternalStore } from "react";
import {
  windowReportJournal,
  type WindowReportsSnapshot,
} from "./windowReportJournal";

/** The provider-report journal, live — what the forecast surfaces read. */
export function useWindowReports(): WindowReportsSnapshot {
  return useSyncExternalStore(
    windowReportJournal.subscribe,
    windowReportJournal.getSnapshot,
  );
}
