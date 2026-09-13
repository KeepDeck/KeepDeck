import { useEffect, useRef } from "react";
import type { GitHistory } from "@keepdeck/plugin-api";
import type { HistoryScope } from "../domain/history";
import { historyList } from "../presentation/historyListView";
import { Trouble } from "./Trouble";

/**
 * The History section's list. What the rows are — the pinned "Since fork"
 * summary, the fork boundary, the commits — is the view model's
 * (`historyList`); this draws them. The walk follows the working tree's
 * HEAD.
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
  // Lazy scroll: when the trailing sentinel button scrolls into view, load
  // the next chunk by itself. The button stays clickable — the fallback for
  // environments without IntersectionObserver, and for keyboard users.
  const moreRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const target = moreRef.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    });
    observer.observe(target);
    return () => observer.disconnect();
    // Re-attach per render window: the sentinel node remounts as the list
    // grows, and `hasMore` flipping off removes it entirely.
  }, [loadMore, hasMore, history]);

  if (error) return <Trouble error={error} />;
  if (!history) return <div className="git__empty">Loading…</div>;

  const list = historyList(history, Date.now());

  return (
    <div className="git__section">
      {list.rows.map((row) =>
        row.kind === "pin" ? (
          <button
            key="pin"
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
          <div key="fork" className="git__forkline" role="separator">
            <span>fork point</span>
          </div>
        ) : (
          <button
            key={row.sha}
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
        ),
      )}
      {list.empty && <div className="git__empty">No commits yet.</div>}
      {hasMore && (
        <button
          type="button"
          className="git__more"
          ref={moreRef}
          onClick={loadMore}
        >
          Show earlier history
        </button>
      )}
    </div>
  );
}
