import type { ResumeBlock, SessionPickRow } from "../domain/agents";
import { baseName } from "../domain/deck";
import { rowKeyOf } from "../domain/journal/sessionRow";
import { formatAge } from "../domain/usage/format";
import { resumeBlockReason } from "./sessionResumeView";

/** One item of the "Start from" picker's list: a session, the loading tail
 * while the next page rides, or the line saying nothing matched. One list
 * of items, because the picker's list is windowed and the window positions
 * and measures every box it shows — the tail and the empty line included. */
export type SessionPickItem =
  | {
      kind: "session";
      key: string;
      row: SessionPickRow;
      name: string;
      meta: string;
      /** The row picked for the pane. */
      active: boolean;
      /** Not resumable here — dimmed, still clickable for its reason. */
      blocked: boolean;
      /** Held by a process outside the app — dimmed less: a fork is legal. */
      busy: boolean;
      /** A line under it: something follows in the list. */
      seam: boolean;
    }
  | { kind: "more"; key: string; label: string }
  | { kind: "empty"; key: string; text: string };

/** The picker's items, in list order. `blockOf` is null when the picker
 * offers forks (no resume gate); `pickedId` is the valid pick's session. */
export function sessionPickItems(
  rows: readonly SessionPickRow[],
  facts: {
    loadingMore: boolean;
    blockOf: ((row: SessionPickRow) => ResumeBlock) | null;
    pickedId: string | null;
    now: number;
  },
): SessionPickItem[] {
  const items: SessionPickItem[] = rows.map((row, index) => {
    const block = facts.blockOf ? facts.blockOf(row) : null;
    const reason = resumeBlockReason(block);
    const where = baseName(row.handle.cwd) || "no directory";
    return {
      kind: "session",
      key: rowKeyOf(row.handle),
      row,
      name: row.handle.title ?? row.handle.sessionId,
      meta: `${where} · ${formatAge(row.mtime, facts.now)}${reason === null ? "" : ` · ${reason}`}`,
      active: facts.pickedId === row.handle.sessionId,
      blocked: block !== null,
      busy: block === "busy-outside",
      seam: index < rows.length - 1 || facts.loadingMore,
    };
  });
  if (facts.loadingMore) items.push({ kind: "more", key: "more", label: "Loading more sessions" });
  else if (rows.length === 0) items.push({ kind: "empty", key: "empty", text: "No sessions match" });
  return items;
}

/** The picker list's accessible name. */
export const SESSION_PICK_LIST_LABEL = "Sessions";

export const sessionPickKey = (item: SessionPickItem): string => item.key;

/** A picker item's first-paint height guess, before it is measured. */
export const SESSION_PICK_ESTIMATE_PX = 47;
