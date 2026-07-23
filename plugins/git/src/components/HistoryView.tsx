import { useEffect, useRef, useState } from "react";
import type { GitBranches } from "@keepdeck/plugin-api";
import { Dropdown } from "@keepdeck/ui-kit/Dropdown";
import { getRuntime } from "../runtime";
import { useGitHistory } from "./useGitHistory";
import {
  relativeTime,
  shortSha,
  type HistoryScope,
} from "../domain/history";
import { CheckIcon } from "../icons";

/**
 * The History half of the Git tab: commits since the branch's fork point
 * (plain recent history when the repo IS the base), with a pinned "Since fork"
 * summary row when a fork applies — log and net-diff are two projections of
 * the same range, so they live on one surface (the PR commits/files-changed
 * model). Any local branch can be browsed by ref, checkout or not.
 *
 * The list is a single pane: clicking a commit (or the since-fork sweep)
 * opens the shared fullscreen peek straight away — its rail IS the commit's
 * file list, the standard file-viewing mode. No in-panel drill, no slide.
 */
export function HistoryView({
  repo,
  version,
  onOpen,
}: {
  repo: string;
  /** The status feed's revision — bumping it re-reads history, so the view
   * follows commits as they land. */
  version: number;
  /** Open the fullscreen peek for a scope — a single commit or the whole
   * since-fork sweep. The peek's rail lists its files. */
  onOpen: (scope: HistoryScope) => void;
}) {
  // Which ref the walk starts from: null = the working tree's checkout.
  // Any local branch can be browsed without being checked out anywhere.
  const [rev, setRev] = useState<string | null>(null);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const { history, error, hasMore, loadMore } = useGitHistory(
    repo,
    version,
    true,
    rev,
  );

  useEffect(() => {
    setRev(null);
    setBranches(null);
  }, [repo]);

  useEffect(() => {
    let cancelled = false;
    const { services, log } = getRuntime();
    services.git
      .branches(repo)
      .then((next) => {
        if (!cancelled) setBranches(next);
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        log.warn(`git branches failed for ${repo}: ${message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [repo, version]);

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
  const pickable = branches !== null && branches.branches.length > 1;

  return (
    <div className="git__section">
      {pickable && (
        <div className="git__refbar">
          <Dropdown
            className="git__ref"
            options={branches.branches.map((name) => ({
              value: name,
              label:
                name === branches.current ? (
                  <span className="git__refcur">
                    {name}
                    <span className="git__refcheck" title="checked out">
                      <CheckIcon />
                    </span>
                  </span>
                ) : (
                  name
                ),
            }))}
            value={rev ?? branches.current ?? branches.branches[0]}
            onChange={(name) =>
              // Picking the checkout goes back to null: the walk follows
              // HEAD and since-fork reaches the working tree again.
              setRev(name === branches.current ? null : name)
            }
            ariaLabel="Branch to browse history for"
          />
        </div>
      )}
      {history.forkSha && (
        <button
          type="button"
          className="git__row git__row--pin"
          onClick={() =>
            onOpen({
              kind: "fork",
              forkSha: history.forkSha!,
              rev: rev ?? undefined,
            })
          }
          title={`Everything since ${shortSha(history.forkSha)}${rev ? "" : ", working tree included"}`}
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
