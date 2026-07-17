import { useEffect, useRef, useState } from "react";
import type { GitBranches, GitChangedFile } from "@keepdeck/plugin-api";
import { Dropdown } from "@keepdeck/ui-kit/Dropdown";
import { getRuntime } from "../runtime";
import { useGitHistory } from "./useGitHistory";
import {
  historyRow,
  relativeTime,
  scopeLabel,
  scopeRange,
  shortSha,
  type HistoryScope,
} from "../domain/history";
import type { ChangeRow } from "../domain/status";
import { FileRow } from "./FileRows";
import { BackIcon, CheckIcon } from "../icons";

/**
 * The History half of the Git tab: commits since the branch's fork point
 * (plain recent history when the repo IS the base), with a pinned "Since fork"
 * summary row when a fork applies — log and net-diff are two projections of
 * the same range, so they live on one surface (the PR commits/files-changed
 * model). Any local branch can be browsed by ref, checkout or not.
 *
 * Clicking a row drills into ITS file list (a commit's files, or everything
 * the branch touched since the fork); clicking a file lifts the range diff
 * into the shared peek via `onOpen`. The list and the drill are two panes on
 * one sliding track — drilling slides forward, backing out slides back; the
 * outgoing pane keeps its content through the transition so nothing blinks.
 */
export function HistoryView({
  repo,
  version,
  onOpen,
}: {
  repo: string;
  /** The status feed's revision — bumping it re-reads history and any open
   * drill, so the view follows commits as they land. */
  version: number;
  /** Lift a file's diff into the peek, tagged with the drilled scope it
   * belongs to — the peek shows the commit (or fork sweep) as provenance. */
  onOpen: (row: ChangeRow, scope: HistoryScope) => void;
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
  const [drill, setDrill] = useState<HistoryScope | null>(null);
  // The drill pane renders THIS through the slide-back, after `drill` is
  // already null — the outgoing screen must not blank mid-animation.
  const lastDrillRef = useRef<HistoryScope | null>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const [files, setFiles] = useState<GitChangedFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);

  useEffect(() => {
    setDrill(null);
    setRev(null);
    setBranches(null);
  }, [repo]);

  // A drilled file list belongs to one walk — leave it when the ref changes.
  useEffect(() => {
    setDrill(null);
  }, [rev]);

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

  // Fetch the drilled range's files. A version bump refetches IN PLACE (no
  // loading flash); only a genuinely different drill clears the list first,
  // so the previous drill's files never masquerade as the new one's.
  const drillKeyRef = useRef("");
  useEffect(() => {
    if (!drill) return; // keep the outgoing content for the slide-back
    const range = scopeRange(drill);
    const key = `${range.from}..${range.to ?? ""}`;
    if (drillKeyRef.current !== key) {
      drillKeyRef.current = key;
      setFiles(null);
      setFilesError(null);
    }
    let cancelled = false;
    const { services, log } = getRuntime();
    services.git
      .changedFiles(repo, range.from, range.to)
      .then((next) => {
        if (cancelled) return;
        setFiles(next);
        setFilesError(null);
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        log.warn(`changed files failed for ${repo}: ${message}`);
        if (cancelled) return;
        setFilesError(message);
        setFiles(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repo, drill, version]);

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

  // Each side of the slide starts reading from the top.
  useEffect(() => {
    sliderRef.current?.closest(".git__list")?.scrollTo({ top: 0 });
  }, [drill]);

  const openDrill = (next: HistoryScope) => {
    lastDrillRef.current = next;
    setDrill(next);
  };

  if (error) return <div className="git__empty git__empty--bad">{error}</div>;
  if (!history) return <div className="git__empty">Loading…</div>;

  const now = Date.now();
  const ahead = history.ahead ?? 0;
  const pickable = branches !== null && branches.branches.length > 1;
  const shownDrill = drill ?? lastDrillRef.current;

  const list = (
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
            openDrill({
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
              openDrill({
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

  const detail = shownDrill && (
    <div className="git__section">
      <button
        type="button"
        className="git__drillback"
        onClick={() => setDrill(null)}
        title="Back to the commit list"
      >
        <BackIcon />
        <span className="git__drilllabel" title={scopeLabel(shownDrill)}>
          {scopeLabel(shownDrill)}
        </span>
      </button>
      {filesError && (
        <div className="git__empty git__empty--bad">{filesError}</div>
      )}
      {!files && !filesError && <div className="git__empty">Loading…</div>}
      {files && files.length === 0 && (
        <div className="git__empty">Nothing changed here.</div>
      )}
      {files?.map((file) => (
        <FileRow
          key={file.path}
          row={historyRow(file)}
          onOpen={(row) => onOpen(row, shownDrill)}
        />
      ))}
    </div>
  );

  return (
    <div className="git__slider" ref={sliderRef}>
      <div className={`git__track${drill ? " git__track--drill" : ""}`}>
        {/* The inactive pane is inert: its buttons must not catch tabs or
            clicks while it sits off-screen. */}
        <div className="git__slidepane" inert={drill !== null}>
          {list}
        </div>
        <div className="git__slidepane" inert={drill === null}>
          {detail}
        </div>
      </div>
    </div>
  );
}
