import type { GitHistory } from "@keepdeck/plugin-api";
import { VirtualList } from "@keepdeck/ui-kit/VirtualList";
import type { HistoryScope } from "../domain/history";
import {
  historyList,
  historyRowKey,
  type HistoryListRow,
} from "../presentation/historyListView";
import { Trouble } from "./Trouble";

/** The first paint's guess per row kind; measurement corrects it. */
const ROW_ESTIMATE_PX: Record<HistoryListRow["kind"], number> = {
  pin: 29,
  fork: 22,
  commit: 24,
  more: 28,
};

/**
 * The History section's list. What the rows are — the pinned "Since fork"
 * summary, the fork boundary, the commits, the tail that asks for more —
 * is the view model's (`historyList`); this draws them, windowed: only
 * the rows in view are mounted, however deep the log goes. The walk
 * follows the working tree's HEAD.
 *
 * A single pane: clicking a commit (or the since-fork sweep) opens the
 * shared fullscreen peek straight away — its rail IS the commit's file
 * list, the standard file-viewing mode. Dumb: the history and its paging
 * come from the owner (`useGitHistory` in the tab), which keeps the window
 * across a collapse of the section.
 */
export function HistoryView({
  history,
  error,
  hasMore,
  loadMore,
  onOpen,
}: {
  history: GitHistory | null;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  /** Open the fullscreen peek for a scope — a single commit or the whole
   * since-fork sweep. The peek's rail lists its files. */
  onOpen: (scope: HistoryScope) => void;
}) {
  if (error) return <Trouble error={error} />;
  if (!history) return <div className="git__empty">Loading…</div>;

  const list = historyList(history, Date.now(), hasMore);

  return (
    <>
      {list.empty && <div className="git__empty">No commits yet.</div>}
      <VirtualList
        items={list.rows}
        itemKey={historyRowKey}
        estimate={(row) => ROW_ESTIMATE_PX[row.kind]}
        className="git__list"
        role="list"
        ariaLabel="History"
        // The tail in view means the reader is at the end of what was
        // read: ask for the next chunk. The button stays for the keyboard.
        onReachEnd={hasMore ? loadMore : undefined}
        render={(row) =>
          row.kind === "pin" ? (
            <button
              type="button"
              className="git__row git__row--pin"
              onClick={() => onOpen(row.scope)}
              title={row.hint}
            >
              <span className="git__code git__code--history" aria-hidden>
                Σ
              </span>
              <span className="git__subject">Since fork</span>
              <span className="git__when">{row.count}</span>
            </button>
          ) : row.kind === "fork" ? (
            <div className="git__forkline" role="separator">
              <span>fork point</span>
            </div>
          ) : row.kind === "more" ? (
            <button type="button" className="git__more" onClick={loadMore}>
              Show earlier history
            </button>
          ) : (
            <button
              type="button"
              className="git__row"
              onClick={() => onOpen(row.scope)}
              title={row.hint}
            >
              <span className="git__subject">{row.subject}</span>
              <span className="git__sha" aria-hidden>
                {row.short}
              </span>
              <span className="git__when">{row.when}</span>
            </button>
          )
        }
      />
    </>
  );
}
