import { useEffect, useRef, useState } from "react";
import type { GitChangedFile } from "@keepdeck/plugin-api";
import { getRuntime } from "../runtime";
import type { ChangeGroups, ChangeRow } from "../domain/status";
import {
  historyRow,
  scopeLabel,
  scopeRange,
  scopeSha,
  shortSha,
  type HistoryScope,
} from "../domain/history";
import { FileRow, FileSection } from "./FileRows";

/** The change set an open diff belongs to — what the peek's rail lists.
 * A union, not optional fields: a worktree diff belongs to the LIVE status
 * groups, a History diff to one drilled scope; never both. */
export type ChangeSet =
  | { kind: "worktree"; groups: ChangeGroups | null }
  | { kind: "history"; scope: HistoryScope };

/**
 * The peek's right-hand rail: every file of the change set the open diff
 * belongs to, the open one marked. Clicking a row switches the peek to that
 * file's diff without leaving the fullscreen view.
 *
 * Worktree diffs list the current status groups (live — the tab's feed
 * re-renders this rail on every refresh). History diffs list the scope's
 * files, fetched here: the drill that opened the peek may have closed, and
 * `version` keeps the list following the repo like every other view.
 */
export function PeekSiblings({
  repo,
  changeSet,
  current,
  version,
  onSelect,
}: {
  repo: string;
  changeSet: ChangeSet;
  /** The row whose diff the peek is showing. */
  current: ChangeRow;
  version: number;
  onSelect: (row: ChangeRow) => void;
}) {
  const scope = changeSet.kind === "history" ? changeSet.scope : null;
  const range = scope && scopeRange(scope);
  const [files, setFiles] = useState<GitChangedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A version bump refetches IN PLACE; only a different scope clears the
  // list first (the HistoryView drill's idiom).
  const keyRef = useRef("");
  useEffect(() => {
    if (!range) return;
    const key = `${range.from}..${range.to ?? ""}`;
    if (keyRef.current !== key) {
      keyRef.current = key;
      setFiles(null);
      setError(null);
    }
    let cancelled = false;
    const { services, log } = getRuntime();
    services.git
      .changedFiles(repo, range.from, range.to)
      .then((next) => {
        if (cancelled) return;
        setFiles(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        log.warn(`changed files failed for ${repo}: ${message}`);
        if (cancelled) return;
        setError(message);
        setFiles(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repo, range?.from, range?.to, version]);

  if (changeSet.kind === "worktree") {
    const groups = changeSet.groups;
    if (!groups) return null;
    return (
      <>
        {groups.total === 0 && (
          <div className="git__empty">No changes — the tree is clean.</div>
        )}
        <FileSection
          label="Conflicts"
          rows={groups.conflicted}
          current={current}
          onOpen={onSelect}
        />
        <FileSection
          label="Staged"
          rows={groups.staged}
          current={current}
          onOpen={onSelect}
        />
        <FileSection
          label="Changes"
          rows={groups.unstaged}
          current={current}
          onOpen={onSelect}
        />
        <FileSection
          label="Untracked"
          rows={groups.untracked}
          current={current}
          onOpen={onSelect}
        />
      </>
    );
  }

  return (
    <>
      <div
        className="git__scopehead"
        title={`${scopeLabel(changeSet.scope)} — ${scopeSha(changeSet.scope)}`}
      >
        <span className="git__scopename">{scopeLabel(changeSet.scope)}</span>
        <span className="git__scopesha">
          {shortSha(scopeSha(changeSet.scope))}
        </span>
      </div>
      {error && <div className="git__empty git__empty--bad">{error}</div>}
      {!files && !error && <div className="git__empty">Loading…</div>}
      {files && files.length === 0 && (
        <div className="git__empty">Nothing changed here.</div>
      )}
      {files?.map((file) => (
        <FileRow
          key={file.path}
          row={historyRow(file)}
          current={current}
          onOpen={onSelect}
        />
      ))}
    </>
  );
}
