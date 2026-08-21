import { useCallback, useRef, useState } from "react";
import type { UnifiedSessionRow } from "../../../domain/journal";
import type { ViewerTarget } from "./SessionViewer";

export function useSessionOpening() {
  const [open, setOpen] = useState<ViewerTarget | null>(null);
  /** Rows whose LAST read by link fell. The row stays and stays
   * openable — a retry is legitimate — but the failure is named on the
   * row, as itself and never as "nothing to read". */
  const [readFailed, setReadFailed] = useState<ReadonlySet<string>>(new Set());

  // Orders transcript responses: a stale page must never render under a
  // newer row's header (the search path has searchSeq; this is its twin).
  const viewSeq = useRef(0);

  const openViewer = (target: ViewerTarget) => {
    viewSeq.current += 1;
    setOpen(target);
  };

  /** Any unified row opens on its read link — the shown link first (a
   * click retries exactly what the row displays), the union chain behind
   * it for the fall-through. STABLE: one function for the whole list's
   * lifetime at this mount — a fresh one per render would re-render
   * every row that receives it. */
  const openRow = useCallback((row: UnifiedSessionRow) => {
    if (row.read === null) return;
    openViewer({
      agent: row.agent,
      sessionId: row.sessionId,
      reference: row.read.reference,
      title: row.title ?? null,
      fallbacks: row.readLinks,
      tried: 0,
      row,
    });
    // openViewer is a stable local over setState/useRef only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeViewer = () => {
    viewSeq.current += 1;
    setOpen(null);
  };

  return {
    open,
    readFailed,
    setReadFailed,
    viewSeq,
    openRow,
    openViewer,
    closeViewer,
  };
}
