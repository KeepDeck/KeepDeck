import { useEffect, useState } from "react";
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
import type { GitRange } from "../domain/history";

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
  row,
  range,
  version,
  onClose,
}: {
  repo: string;
  row: ChangeRow;
  /** Present for History rows: diff across this revision range instead of
   * against the index (`to` omitted = up to the working tree). */
  range?: GitRange;
  version: number;
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Joined flat text compares by VALUE in the hook's deps, so rebuilding the
  // string each render never re-triggers tokenization.
  const showsCode = diff !== null && !diff.binary;
  const tokens = useHighlight(
    showsCode ? flatLines(diff).join("\n") : null,
    langFor(row.path),
  );
  const offsets = showsCode ? hunkOffsets(diff) : [];

  useEffect(() => {
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
  }, [repo, row.path, row.kind, range?.from, range?.to, version]);

  return (
    <Peek
      ariaLabel={`Diff of ${baseName(row.path)}`}
      name={baseName(row.path)}
      meta={
        <span className={`git__badge git__badge--${row.kind}`}>
          {codeLabel(row.code)}
          {row.kind === "staged" ? " · staged" : ""}
        </span>
      }
      path={row.origPath ? `${row.origPath} → ${row.path}` : row.path}
      onClose={onClose}
    >
      {!diff && !error && <p className="peek__note">Loading…</p>}
      {error && <p className="peek__note peek__note--bad">{error}</p>}
      {diff?.binary && <p className="peek__note">Binary file — no text diff.</p>}
      {diff && isEmptyDiff(diff) && (
        <p className="peek__note">No changes here anymore.</p>
      )}
      {diff && !diff.binary && (
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
                    <span className="git__lineno" aria-hidden>
                      {line.oldNo ?? ""}
                    </span>
                    <span className="git__lineno" aria-hidden>
                      {line.newNo ?? ""}
                    </span>
                    <span className="git__linemark" aria-hidden>
                      {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
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
