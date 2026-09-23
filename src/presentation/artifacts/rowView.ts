import type {
  ArtifactMetaRow,
  ArtifactVersionRow,
} from "../../app/artifacts/registryRead";
import { formatAge } from "../../domain/usage";
import { rowMeta, versionsNewestFirst } from "./rowMeta";
import { HISTORY_GONE, HISTORY_LOADING } from "./words";
import { isRow, type RowRef } from "../../domain/artifacts/rowRef";

/** An open history, and WHICH row it belongs to. The versions are null
 * while the read is still out. */
export interface OpenHistory extends RowRef {
  versions: readonly ArtifactVersionRow[] | null;
}

/** One version line, drawn as given. */
export interface VersionLineView {
  n: number;
  label: string;
  when: string;
  /** The agent's note about what changed, when it left one. */
  message: string | null;
}

/** What sits under an open row: a line saying why there are no versions
 * to show — still reading, or the artifact went — or the versions. */
export type HistoryView =
  | { kind: "note"; text: string }
  | { kind: "versions"; lines: readonly VersionLineView[] };

/**
 * Everything one artifact row shows, decided away from the markup: its
 * words, whether an action is in flight for it, and its history when it
 * is the open one. The dialog maps these fields and chooses nothing.
 */
export interface ArtifactRowView {
  title: string;
  id: string;
  /** The identity line after the id: ` · v3 · 2h ago`. */
  tail: string;
  openLabel: string;
  deleteLabel: string;
  /** An action is in flight for this row; it takes no second one. */
  busy: boolean;
  toggleLabel: string;
  /** Null while the row is closed. */
  history: HistoryView | null;
}

export function artifactRowView(
  row: ArtifactMetaRow,
  now: number,
  busyId: string | null,
  open: OpenHistory | null,
): ArtifactRowView {
  const meta = rowMeta(row, now);
  // The FULL ref, not the id: the effect that drops a stale history runs
  // after paint, and an id alone would draw one workspace's versions
  // under another's artifact of the same name for that frame.
  const history = open !== null && isRow(open, row) ? historyOf(open, now) : null;
  return {
    title: row.title,
    id: meta.id,
    tail: meta.tail,
    openLabel: `Open ${row.title}`,
    deleteLabel: `Delete ${row.title}`,
    busy: busyId === row.id,
    toggleLabel: history === null ? "History" : "Hide history",
    history,
  };
}

function historyOf(open: OpenHistory, now: number): HistoryView {
  if (open.versions === null) return { kind: "note", text: HISTORY_LOADING };
  if (open.versions.length === 0) return { kind: "note", text: HISTORY_GONE };
  return {
    kind: "versions",
    lines: versionsNewestFirst(open.versions).map((version) => ({
      n: version.n,
      label: `v${version.n}`,
      when: formatAge(version.at, now),
      message: version.message ?? null,
    })),
  };
}
