import { useEffect, useState } from "react";
import type { GitChangedFile } from "@keepdeck/plugin-api";
import { getRuntime } from "../runtime";
import { useGitHistory } from "./useGitHistory";
import {
  commitRange,
  historyRow,
  relativeTime,
  shortSha,
  sinceForkRange,
  type GitRange,
} from "../domain/history";
import { baseName, codeLabel, dirName, type ChangeRow } from "../domain/status";
import { BackIcon } from "../icons";

/**
 * The History half of the Git tab: commits since the branch's fork point
 * (plain recent history when the repo IS the base), with a pinned "Since fork"
 * summary row when a fork applies — log and net-diff are two projections of
 * the same range, so they live on one surface (the PR commits/files-changed
 * model).
 *
 * Clicking a row drills into ITS file list (a commit's files, or everything
 * the branch touched since the fork, working tree included); clicking a file
 * lifts the range diff into the shared peek via `onOpen`. Drill state is
 * local: switching roots or leaving History resets it by unmount.
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
  onOpen: (row: ChangeRow, range: GitRange) => void;
}) {
  const { history, error } = useGitHistory(repo, version, true);
  const [drill, setDrill] = useState<{ label: string; range: GitRange } | null>(
    null,
  );
  const [files, setFiles] = useState<GitChangedFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);

  useEffect(() => {
    setDrill(null);
  }, [repo]);

  useEffect(() => {
    if (!drill) {
      setFiles(null);
      setFilesError(null);
      return;
    }
    let cancelled = false;
    const { services, log } = getRuntime();
    services.git
      .changedFiles(repo, drill.range.from, drill.range.to)
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

  if (error) return <div className="git__empty git__empty--bad">{error}</div>;
  if (!history) return <div className="git__empty">Loading…</div>;

  if (drill) {
    return (
      <div className="git__section">
        <button
          type="button"
          className="git__drillback"
          onClick={() => setDrill(null)}
          title="Back to the commit list"
        >
          <BackIcon />
          <span className="git__drilllabel" title={drill.label}>
            {drill.label}
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
          <button
            type="button"
            className="git__row"
            key={file.path}
            onClick={() => onOpen(historyRow(file), drill.range)}
            title={`${file.path} — ${codeLabel(file.code)}`}
          >
            <span
              className={`git__code git__code--${file.code === "D" ? "del" : "history"}`}
              aria-hidden
            >
              {file.code}
            </span>
            <span className="git__file">
              {dirName(file.path) && (
                <span className="git__dir">{dirName(file.path)}</span>
              )}
              <span className="git__base">{baseName(file.path)}</span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  const now = Date.now();
  return (
    <div className="git__section">
      {history.forkSha && (
        <button
          type="button"
          className="git__row git__row--pin"
          onClick={() =>
            setDrill({
              label: "Since fork",
              range: sinceForkRange(history.forkSha!),
            })
          }
          title={`Everything since ${shortSha(history.forkSha)}, working tree included`}
        >
          <span className="git__code git__code--history" aria-hidden>
            Σ
          </span>
          <span className="git__subject">Since fork</span>
          <span className="git__when">
            {history.commits.length}{" "}
            {history.commits.length === 1 ? "commit" : "commits"}
          </span>
        </button>
      )}
      {history.commits.length === 0 && (
        <div className="git__empty">
          {history.forkSha
            ? "No commits since the fork."
            : "No commits yet."}
        </div>
      )}
      {history.commits.map((commit) => (
        <button
          type="button"
          className="git__row"
          key={commit.sha}
          onClick={() =>
            setDrill({ label: commit.subject, range: commitRange(commit.sha) })
          }
          title={`${commit.subject} — ${commit.author}`}
        >
          <span className="git__subject">{commit.subject}</span>
          <span className="git__sha" aria-hidden>
            {shortSha(commit.sha)}
          </span>
          <span className="git__when">{relativeTime(commit.timestamp, now)}</span>
        </button>
      ))}
    </div>
  );
}
