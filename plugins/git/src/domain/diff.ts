/**
 * Pure parser of git's unified diff text into a renderable model. The service
 * returns the raw text verbatim (`services.git.diffFile`); everything about
 * lines, hunks and gutters is presentation and lives here — no React, no
 * services, fully unit-testable.
 */

export type DiffLineKind = "add" | "del" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line's text WITHOUT its +/-/space marker. */
  text: string;
  /** 1-based line number on the old side; null where the line doesn't exist
   * there (an added line) or isn't a file line (meta). */
  oldNo: number | null;
  /** 1-based line number on the new side; null for deleted/meta lines. */
  newNo: number | null;
}

export interface DiffHunk {
  /** The raw `@@ -a,b +c,d @@ …` header (shown as the hunk separator). */
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  hunks: DiffHunk[];
  /** Git printed "Binary files … differ" instead of hunks. */
  binary: boolean;
}

/** Whether a parsed diff has nothing to show. */
export function isEmptyDiff(diff: FileDiff): boolean {
  return !diff.binary && diff.hunks.length === 0;
}

/** Parse `git diff` output. Preamble lines (`diff --git`, `index`, `---`,
 * `+++`, rename/mode notes) are dropped — the peek's own header names the
 * file; `\ No newline at end of file` stays, as a dim meta line. */
export function parseDiff(raw: string): FileDiff {
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const hunks: DiffHunk[] = [];
  let binary = false;
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 1;
      newNo = m ? Number(m[2]) : 1;
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        binary = true;
      }
      continue;
    }
    if (line.startsWith("+")) {
      current.lines.push({
        kind: "add",
        text: line.slice(1),
        oldNo: null,
        newNo: newNo++,
      });
    } else if (line.startsWith("-")) {
      current.lines.push({
        kind: "del",
        text: line.slice(1),
        oldNo: oldNo++,
        newNo: null,
      });
    } else if (line.startsWith("\\")) {
      current.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else {
      current.lines.push({
        kind: "context",
        text: line.slice(1),
        oldNo: oldNo++,
        newNo: newNo++,
      });
    }
  }
  return { hunks, binary };
}

/** An untracked file "diff": its whole content as one all-added hunk — git has
 * nothing to compare it against, but the peek should read the same. */
export function newFileDiff(text: string): FileDiff {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return {
    binary: false,
    hunks: [
      {
        header: "",
        lines: lines.map((line, index) => ({
          kind: "add",
          text: line,
          oldNo: null,
          newNo: index + 1,
        })),
      },
    ],
  };
}
