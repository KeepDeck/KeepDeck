import type { LineTokens } from "@keepdeck/code-kit";
import type { DiffHunk, DiffLine, FileDiff } from "../domain/diff";

/**
 * Which colors each line of a diff wears — the plan the peek tokenizes by.
 *
 * A diff is not a document a grammar can read: its hunks are fragments with
 * the gaps between them cut out, and its removed and added lines interleave.
 * Tokenized as one text, a `/*` on a removed line, or one in a gap whose `*\/`
 * fell in the next, painted real code as comment. So each line takes its
 * colors from a document that IS one:
 *
 * - its side read whole, when the side was read and the line there reads
 *   exactly as the diff shows it — a removed line from the old side by its
 *   old number, an added one from the new side, an unchanged one from
 *   either. The texts are compared because the two reads can race an edit,
 *   and a capped side ends early; a CR the working file has and the diff
 *   does not (git normalizes line endings into what it stores and shows) is
 *   the one difference forgiven, and dropped from the line's colors.
 * - else that side of its own hunk: the hunk's unchanged and removed lines,
 *   or its unchanged and added ones. Nothing carries between hunks; a hunk
 *   that starts inside a comment still reads its first lines as code — the
 *   best a fragment allows.
 */

export interface LineSource {
  /** Index into `texts`. */
  doc: number;
  /** 0-based line within that document. */
  line: number;
  /** The document's line ends in a CR the diff line does not show. */
  dropCr: boolean;
}

export interface DiffHighlightPlan {
  /** The documents to tokenize, in order. */
  texts: string[];
  /** Per hunk, per line: where its colors come from; null for a meta line
   * ("\ No newline…" is not code). */
  sources: (LineSource | null)[][];
}

type Side = "old" | "new";

/** A side's whole text, split once. */
interface WholeSide {
  text: string;
  lines: string[];
}

/**
 * The plan for `diff`, with each side's whole text where it was read (null
 * where it was not, or does not exist). `fits` is whether a document is worth
 * tokenizing at all — a side too large for the highlighter falls back to its
 * hunks rather than leaving the whole diff plain.
 */
export function diffHighlightPlan(
  diff: FileDiff,
  sides: { old: string | null; new: string | null },
  fits: (text: string) => boolean,
): DiffHighlightPlan {
  const texts: string[] = [];
  const add = (text: string) => texts.push(text) - 1;

  const whole = (text: string | null): WholeSide | null =>
    text !== null && fits(text) ? { text, lines: text.split("\n") } : null;
  const wholeSides: Record<Side, WholeSide | null> = {
    old: whole(sides.old),
    new: whole(sides.new),
  };
  // Added on first use: a side no line matches is never tokenized.
  const wholeDocs: Record<Side, number | null> = { old: null, new: null };

  const fromWhole = (side: Side, number: number | null, text: string): LineSource | null => {
    const source = wholeSides[side];
    if (!source || number === null) return null;
    const stored = source.lines[number - 1];
    if (stored === undefined) return null;
    const dropCr = stored !== text && stored === `${text}\r`;
    if (stored !== text && !dropCr) return null;
    wholeDocs[side] ??= add(source.text);
    return { doc: wholeDocs[side], line: number - 1, dropCr };
  };

  const sources = diff.hunks.map((hunk) => {
    // The hunk's own two sides, made on first need: the document, and where
    // each of its lines sits in it.
    const hunkDocs: Partial<Record<Side, { doc: number; at: Map<DiffLine, number> }>> = {};
    const fromHunk = (side: Side, line: DiffLine): LineSource => {
      let made = hunkDocs[side];
      if (!made) {
        const lines = hunkSide(hunk, side);
        made = {
          doc: add(lines.map((each) => each.text).join("\n")),
          at: new Map(lines.map((each, index) => [each, index])),
        };
        hunkDocs[side] = made;
      }
      return { doc: made.doc, line: made.at.get(line) ?? 0, dropCr: false };
    };
    return hunk.lines.map((line): LineSource | null => {
      switch (line.kind) {
        case "meta":
          return null;
        case "del":
          return fromWhole("old", line.oldNo, line.text) ?? fromHunk("old", line);
        case "add":
          return fromWhole("new", line.newNo, line.text) ?? fromHunk("new", line);
        case "context":
          return (
            fromWhole("new", line.newNo, line.text) ??
            fromWhole("old", line.oldNo, line.text) ??
            fromHunk("new", line)
          );
      }
    });
  });
  return { texts, sources };
}

/** One side of a hunk: its unchanged lines with its removed (old) or added
 * (new) ones, in order. */
function hunkSide(hunk: DiffHunk, side: Side): DiffLine[] {
  const own = side === "old" ? "del" : "add";
  return hunk.lines.filter((line) => line.kind === "context" || line.kind === own);
}

/** The colors of line `i` in hunk `h`, once the plan's documents are
 * tokenized; undefined while they are not, or for a meta line. */
export function lineTokens(
  plan: DiffHighlightPlan,
  docs: LineTokens[][] | null,
  h: number,
  i: number,
): LineTokens | undefined {
  const source = plan.sources[h]?.[i];
  const runs = source ? docs?.[source.doc]?.[source.line] : undefined;
  return runs && source?.dropCr ? withoutCr(runs) : runs;
}

/** `runs` without the trailing CR the aligner keeps as a run of its own. */
function withoutCr(runs: LineTokens): LineTokens {
  const last = runs[runs.length - 1];
  if (!last?.text.endsWith("\r")) return runs;
  const rest = last.text.slice(0, -1);
  return rest === "" ? runs.slice(0, -1) : [...runs.slice(0, -1), { ...last, text: rest }];
}
