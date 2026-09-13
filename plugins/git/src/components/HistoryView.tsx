import { useEffect, useRef } from "react";
import type { GitHistory } from "@keepdeck/plugin-api";
import { relativeTime, shortSha, type HistoryScope } from "../domain/history";

/**
 * The History section's list: commits since the branch's fork point (plain
 * recent history when the repo IS the base), with a pinned "Since fork"
 * summary row when a fork applies — log and net-diff are two projections of
 * the same range, so they live on one surface (the PR commits/files-changed
 * model). The walk follows the working tree's HEAD.
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

  if (error) return <div className="git__empty git__empty--bad">{error}</div>;
  if (!history) return <div className="git__empty">Loading…</div>;

  const now = Date.now();
  const ahead = history.ahead ?? 0;

  return (
    <div className="git__section">
      {history.forkSha && (
        <button
          type="button"
          className="git__row git__row--pin"
          onClick={() => onOpen({ kind: "fork", forkSha: history.forkSha! })}
          title={`Everything since ${shortSha(history.forkSha)}, working tree included`}
        >
          <span className="git__code git__code--history" aria-hidden>
            Σ
          </span>
          <span className="git__subject">Since fork</span>
          <span className="git__when">
            {ahead} {ahead === 1 ? "commit" : "commits"}
          </span>
        </button>
      )}
      {history.commits.length === 0 && (
        <div className="git__empty">No commits yet.</div>
      )}
      {history.commits.map((commit) => (
        // The full log, boundary drawn AT the fork commit: everything above
        // the divider is the branch's own work, below it the base history.
        <div key={commit.sha}>
          {commit.sha === history.forkSha && (
            <div className="git__forkline" role="separator">
              <span>fork point</span>
            </div>
          )}
          <button
            type="button"
            className="git__row"
            onClick={() =>
              onOpen({
                kind: "commit",
                sha: commit.sha,
                subject: commit.subject,
              })
            }
            title={`${commit.subject} — ${commit.author}`}
          >
            <span className="git__subject">{commit.subject}</span>
            <span className="git__sha" aria-hidden>
              {shortSha(commit.sha)}
            </span>
            <span className="git__when">
              {relativeTime(commit.timestamp, now)}
            </span>
          </button>
        </div>
      ))}
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
