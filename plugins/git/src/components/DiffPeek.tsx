import { useEffect, useRef, useState } from "react";
import { getRuntime } from "../runtime";
import {
  isEmptyDiff,
  newFileDiff,
  parseDiff,
  type FileDiff,
} from "../domain/diff";
import { baseName, codeLabel, type ChangeRow } from "../domain/status";
import { BackIcon } from "../icons";

/**
 * One change's diff — the same wide "peek" overlay the Files tab uses for
 * previews (a 340px rail can't read a diff). Which diff depends on the row's
 * section: staged rows peek index-vs-HEAD, changed rows worktree-vs-index,
 * untracked rows render the file's content as all-added (git has no diff for
 * them). Dismiss with Esc, the back button, or a click on the backdrop.
 *
 * `version` is the status feed's revision: when the watcher refreshes the
 * list, an open peek re-fetches too, so it never shows yesterday's hunks. A
 * stale in-flight read is ignored the same way FileViewer's is.
 */
export function DiffPeek({
  repo,
  row,
  version,
  onClose,
}: {
  repo: string;
  row: ChangeRow;
  version: number;
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const { services, log } = getRuntime();
    const read =
      row.kind === "untracked"
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
  }, [repo, row.path, row.kind, version]);

  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  return (
    <div
      className="git__peek"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div
        className="git__peekpanel"
        role="dialog"
        aria-modal="true"
        aria-label={`Diff of ${baseName(row.path)}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="git__dhead">
          <button
            type="button"
            className="git__dback"
            onClick={onClose}
            title="Back to the changes (Esc)"
            aria-label="Back to the changes"
          >
            <BackIcon />
          </button>
          <span className="git__dname" title={row.path}>
            {baseName(row.path)}
          </span>
          <span className={`git__badge git__badge--${row.kind}`}>
            {codeLabel(row.code)}
            {row.kind === "staged" ? " · staged" : ""}
          </span>
        </div>
        {row.origPath && (
          <div className="git__dpath" title={`renamed from ${row.origPath}`}>
            {row.origPath} → {row.path}
          </div>
        )}
        {!row.origPath && (
          <div className="git__dpath" title={row.path}>
            {row.path}
          </div>
        )}
        <div className="git__dbody" ref={bodyRef} tabIndex={0}>
          {!diff && !error && <p className="git__note">Loading…</p>}
          {error && <p className="git__note git__note--bad">{error}</p>}
          {diff?.binary && (
            <p className="git__note">Binary file — no text diff.</p>
          )}
          {diff && isEmptyDiff(diff) && (
            <p className="git__note">No changes here anymore.</p>
          )}
          {diff && !diff.binary && (
            <div className="git__diff">
              {diff.hunks.map((hunk, h) => (
                // Hunks are positional and never reordered — index keys are
                // stable for one render's diff.
                <div key={h}>
                  {hunk.header && (
                    <div className="git__hunkhead">{hunk.header}</div>
                  )}
                  {hunk.lines.map((line, i) => (
                    <div
                      className={`git__diffrow git__diffrow--${line.kind}`}
                      key={i}
                    >
                      <span className="git__lineno" aria-hidden>
                        {line.oldNo ?? ""}
                      </span>
                      <span className="git__lineno" aria-hidden>
                        {line.newNo ?? ""}
                      </span>
                      <span className="git__linemark" aria-hidden>
                        {line.kind === "add"
                          ? "+"
                          : line.kind === "del"
                            ? "-"
                            : " "}
                      </span>
                      {/* A space keeps an empty line's row height under
                          white-space: pre. */}
                      <span className="git__linetext">{line.text || " "}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
