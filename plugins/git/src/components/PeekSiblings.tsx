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
import { changeSetKey } from "../domain/identity";
import { navigate, type ArrowKey } from "../domain/navigate";
import { FileRow, FileSection } from "./FileRows";

/** Arrow keys the rail consumes, mapped to the pure navigator's vocabulary. */
const ARROW_KEYS: Record<string, ArrowKey | undefined> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** The change set an open diff belongs to — what the peek's rail lists.
 * A union, not optional fields: a worktree diff belongs to the LIVE status
 * groups, a History diff to one drilled scope; never both.
 *
 * `error` carries the status feed's own failure. A peek can outlive the
 * worktree it opened on (closing the pane deletes it), and the rail is where
 * that has to be said — silently dropping the list left the reader looking at
 * hunks of a directory that no longer exists. */
export type ChangeSet =
  | { kind: "worktree"; groups: ChangeGroups | null; error: string | null }
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
 *
 * Arrow keys walk the rail from anywhere in the peek (it is modal, so the
 * listener is window-wide): Up/Down step through files, Left/Right jump by
 * directory — the Files tab's model flattened. The diff body loses arrow
 * scrolling to this on purpose; wheel and PageUp/Down still scroll it.
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
  /** The row whose diff the peek is showing. Null while a History scope is
   * open but no file is chosen yet — the rail seeds the first one. */
  current: ChangeRow | null;
  version: number;
  onSelect: (row: ChangeRow) => void;
}) {
  const scope = changeSet.kind === "history" ? changeSet.scope : null;
  const range = scope && scopeRange(scope);
  // The fetch's outcome, stored WITH the change set it belongs to and as ONE
  // union rather than a list beside an error.
  //
  // Keyed, because clearing a list is a state update: within the render that
  // switched scopes the old list would still be there, and the seed below
  // would open one of its files under the new scope's header. A union,
  // because a list and an error must not both be current — a failed refetch
  // under an unchanged key left the previous list rendered UNDER the error
  // banner, still clickable, still seedable. It also means a failure does not
  // blink away and back on every refresh, the way clearing up front would.
  const [fetched, setFetched] = useState<
    | { key: string; files: GitChangedFile[] }
    | { key: string; error: string }
    | null
  >(null);

  // One key drives the fetch, the clear and the seed, so they cannot
  // disagree about what a different list is — `repo` included, since two
  // worktrees of one repo share shas.
  const key = changeSetKey(repo, range || undefined);
  // Only an outcome that belongs to the CURRENT change set counts.
  const settled = fetched?.key === key ? fetched : null;
  const files = settled && "files" in settled ? settled.files : null;
  const error = settled && "error" in settled ? settled.error : null;

  // The rail's rows in visual order — what the arrows walk.
  const groups = changeSet.kind === "worktree" ? changeSet.groups : null;
  const rows: ChangeRow[] =
    changeSet.kind === "worktree"
      ? groups
        ? [
            ...groups.conflicted,
            ...groups.staged,
            ...groups.unstaged,
            ...groups.untracked,
          ]
        : []
      : (files ?? []).map(historyRow);

  // One window listener for the peek's lifetime; the latest rows/selection
  // come through a ref so re-renders don't churn the subscription.
  const navRef = useRef({ rows, current, onSelect });
  navRef.current = { rows, current, onSelect };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return;
      const key = ARROW_KEYS[event.key];
      if (!key) return;
      const latest = navRef.current;
      if (latest.rows.length === 0) return;
      // No file selected yet (the seed hasn't landed) — arrows wait.
      if (!latest.current) return;
      // Arrows mean rail navigation everywhere in the peek — swallow the
      // default even when clamped, so the diff never scroll-jumps instead.
      event.preventDefault();
      const next = navigate(latest.rows, latest.current, key);
      if (next) latest.onSelect(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Keep the marked row in view as the arrows move it.
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    railRef.current
      ?.querySelector("[aria-current]")
      ?.scrollIntoView({ block: "nearest" });
  }, [current?.path, current?.kind]);

  // A version bump refetches IN PLACE; a different change set supersedes the
  // list, which needs no separate clear — the list carries the key it was
  // fetched for, so a stale one simply stops counting as loaded.
  useEffect(() => {
    if (!range) return;
    let cancelled = false;
    const { services, log } = getRuntime();
    services.git
      .changedFiles(repo, range.from, range.to)
      .then((next) => {
        if (cancelled) return;
        setFetched({ key, files: next });
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        log.warn(`changed files failed for ${repo}: ${message}`);
        if (cancelled) return;
        // Supersedes the list this key had: a rail that shows an error must
        // not also offer rows read before it.
        setFetched({ key, error: message });
      });
    return () => {
      cancelled = true;
    };
    // `version` rides alongside the key: it must refetch WITHOUT counting as
    // a different change set.
  }, [key, version]);

  // A History scope opens the peek without a file yet — seed the first one
  // the moment its file list lands, so the body shows a diff at once. The
  // rail is the single owner of the scope's file fetch, so it owns the seed.
  const isHistory = changeSet.kind === "history";
  useEffect(() => {
    if (!isHistory || current || !files || files.length === 0) return;
    onSelect(historyRow(files[0]));
  }, [isHistory, current, files, onSelect]);

  if (changeSet.kind === "worktree") {
    // The repo stopped answering — say so where the list would have been.
    // The body says it too (the diff re-read fails on the same version bump),
    // but the rail is what visibly disappeared.
    if (changeSet.error) {
      return (
        <div className="git__empty git__empty--bad">{changeSet.error}</div>
      );
    }
    if (!groups) return null;
    return (
      <div ref={railRef}>
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
      </div>
    );
  }

  return (
    <div ref={railRef}>
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
    </div>
  );
}
