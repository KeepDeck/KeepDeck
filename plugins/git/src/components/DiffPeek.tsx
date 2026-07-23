import { useEffect, useRef, useState } from "react";
import { Peek } from "@keepdeck/ui-kit/Peek";
import { langFor, TokenLine, useHighlight } from "@keepdeck/code-kit";
import { getRuntime } from "../runtime";
import {
  flatLines,
  hunkOffsets,
  isEmptyDiff,
  newFileDiff,
  parseDiff,
  type FileDiff,
} from "../domain/diff";
import { baseName, codeLabel, type ChangeRow } from "../domain/status";
import {
  scopeLabel,
  scopeRange,
  scopeSha,
  shortSha,
  type HistoryScope,
} from "../domain/history";
import { PeekSiblings, type ChangeSet } from "./PeekSiblings";

/** What the peek shows. `file` is a chosen row's diff (worktree or history
 * range); `waiting` is a history scope that opened before the rail seeded its
 * first file — the body stays blank, the header carries the scope label, and
 * the rail owns the loading/empty/error note. Splitting "no file yet" into
 * its own variant makes the impossible null-row-worktree unrepresentable, so
 * nothing here leans on a non-null assertion. */
export type PeekView =
  | { kind: "file"; row: ChangeRow; changeSet: ChangeSet }
  | { kind: "waiting"; scope: HistoryScope };

/**
 * One change's diff, inside the shared `Peek` overlay (ui-kit) — the shell is
 * the kit's; this component owns the diff that fills it. Which diff depends on
 * the row's section: staged rows peek index-vs-HEAD, changed rows
 * worktree-vs-index, untracked rows render the file's content as all-added
 * (git has no diff for them).
 *
 * Lines are syntax-colored by the changed file's language (code-kit, the same
 * engine as the Files preview): the hunks' lines tokenize as ONE flat document
 * — an approximation, since hunks start mid-file and add/del runs interleave,
 * but the aligner's guarantee holds (a drifted line degrades to plain, never
 * to wrong text) and the add/del tints stay as row backgrounds under the
 * colored runs. Meta lines keep their dim styling, uncolored.
 *
 * `version` is the status feed's revision: when the watcher refreshes the
 * list, an open peek re-fetches too, so it never shows yesterday's hunks. A
 * stale in-flight read is ignored the same way the files preview's is.
 */
export function DiffPeek({
  repo,
  view,
  version,
  onSelect,
  onClose,
}: {
  repo: string;
  /** What the peek shows: a chosen file's diff, or a history scope awaiting
   * its first file (the body waits blank, the header carries the scope). */
  view: PeekView;
  version: number;
  /** Switch the peek to another row of the same change set. */
  onSelect: (row: ChangeRow) => void;
  onClose: () => void;
}) {
  const row = view.kind === "file" ? view.row : null;
  const changeSet: ChangeSet =
    view.kind === "file"
      ? view.changeSet
      : { kind: "history", scope: view.scope };
  const scope: HistoryScope | null =
    view.kind === "waiting"
      ? view.scope
      : view.changeSet.kind === "history"
        ? view.changeSet.scope
        : null;
  const range = scope ? scopeRange(scope) : undefined;
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Joined flat text compares by VALUE in the hook's deps, so rebuilding the
  // string each render never re-triggers tokenization.
  const showsCode = diff !== null && !diff.binary;
  const tokens = useHighlight(
    showsCode ? flatLines(diff).join("\n") : null,
    view.kind === "file" ? langFor(view.row.path) : null,
  );
  const offsets = showsCode ? hunkOffsets(diff) : [];

  // A version bump refreshes the open diff IN PLACE; switching to another
  // file clears it first, so the old hunks never show under the new name.
  const diffKeyRef = useRef("");
  useEffect(() => {
    // No file to diff yet — the rail seeds the first file of a History scope.
    if (!row) return;
    const key = `${row.kind}:${row.path}:${range?.from ?? ""}:${range?.to ?? ""}`;
    if (diffKeyRef.current !== key) {
      diffKeyRef.current = key;
      setDiff(null);
      setError(null);
    }
    let cancelled = false;
    const { services, log } = getRuntime();
    const read = range
      ? services.git
          .diffFile(repo, row.path, { from: range.from, to: range.to })
          .then(parseDiff)
      : row.kind === "untracked"
        ? services.fs
            .readFile(`${repo.replace(/\/+$/, "")}/${row.path}`)
            .then((file) =>
              file.isBinary || file.text === null
                ? { binary: true, hunks: [] }
                : newFileDiff(file.text),
            )
        : services.git
            .diffFile(repo, row.path, { staged: row.kind === "staged" })
            .then(parseDiff);
    read
      .then((next) => {
        if (cancelled) return;
        setDiff(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        log.warn(`diff failed for ${row.path}: ${message}`);
        if (cancelled) return;
        setError(message);
        setDiff(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repo, row?.path, row?.kind, range?.from, range?.to, version]);

  const waiting = view.kind === "waiting";
  return (
    <Peek
      ariaLabel={
        waiting ? scopeLabel(view.scope) : `Diff of ${baseName(view.row.path)}`
      }
      name={waiting ? scopeLabel(view.scope) : baseName(view.row.path)}
      meta={
        waiting ? (
          <span className="git__badge">{shortSha(scopeSha(view.scope))}</span>
        ) : (
          <span className={`git__badge git__badge--${view.row.kind}`}>
            {codeLabel(view.row.code)}
          </span>
        )
      }
      path={
        waiting
          ? undefined
          : view.row.origPath
            ? `${view.row.origPath} → ${view.row.path}`
            : view.row.path
      }
      aside={
        // No rail before the status has ever loaded — an empty column says
        // nothing (a loaded-then-empty worktree still shows its clean note).
        changeSet.kind === "worktree" && !changeSet.groups ? undefined : (
          <PeekSiblings
            repo={repo}
            changeSet={changeSet}
            current={row}
            version={version}
            onSelect={onSelect}
          />
        )
      }
      onClose={onClose}
    >
      {/* A waiting scope has no file yet — the body stays blank; the rail
          owns the loading/empty/error note. */}
      {view.kind === "file" && !diff && !error && (
        <p className="peek__note">Loading…</p>
      )}
      {view.kind === "file" && error && (
        <p className="peek__note peek__note--bad">{error}</p>
      )}
      {view.kind === "file" && diff?.binary && (
        <p className="peek__note">Binary file — no text diff.</p>
      )}
      {view.kind === "file" && diff && isEmptyDiff(diff) && (
        <p className="peek__note">No changes here anymore.</p>
      )}
      {view.kind === "file" && diff && !diff.binary && (
        <div className="git__diff">
          {diff.hunks.map((hunk, h) => (
            // Hunks are positional and never reordered — index keys are
            // stable for one render's diff.
            <div key={h}>
              {hunk.header && <div className="git__hunkhead">{hunk.header}</div>}
              {hunk.lines.map((line, i) => {
                // Meta lines ("\ No newline…") aren't code — keep their dim
                // CSS color instead of the tokenizer's guess.
                const runs =
                  line.kind !== "meta" ? tokens?.[offsets[h] + i] : undefined;
                return (
                  <div
                    className={`git__diffrow git__diffrow--${line.kind}`}
                    key={i}
                  >
                    {/* Only the side a line exists on carries a number —
                        dels the old, adds the new. With the ± column gone,
                        the diff CSS leans on this as the hue-free add/del
                        cue; don't fill both gutters without giving that
                        signal a new home. */}
                    <span className="git__lineno" aria-hidden>
                      {line.oldNo ?? ""}
                    </span>
                    <span className="git__lineno" aria-hidden>
                      {line.newNo ?? ""}
                    </span>
                    {/* A space keeps an empty line's row height under
                        white-space: pre. */}
                    <span className="git__linetext">
                      {runs ? <TokenLine tokens={runs} /> : line.text || " "}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Peek>
  );
}
