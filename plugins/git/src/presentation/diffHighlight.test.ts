import { beforeAll, describe, expect, it } from "vitest";
import { tokenizeLines, type LineTokens } from "@keepdeck/code-kit";
import { installInProcessWorker } from "@keepdeck/code-kit/testing";
import { parseDiff, newFileDiff } from "../domain/diff";
import { diffHighlightPlan, lineTokens, type DiffHighlightPlan } from "./diffHighlight";

const fitsAll = () => true;

/** The (doc, line) each line of each hunk reads from, compactly. */
const where = (plan: DiffHighlightPlan) =>
  plan.sources.map((hunk) => hunk.map((source) => (source ? `${source.doc}:${source.line}` : "-")));

const OLD = "a\nb\nc\nd\n";
const NEW = "a\nB\nc\nd\n";
const ONE_HUNK = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";

describe("diffHighlightPlan", () => {
  it("colors each line from its side read whole: removed from old, added and unchanged from new", () => {
    const plan = diffHighlightPlan(parseDiff(ONE_HUNK), { old: OLD, new: NEW }, fitsAll);
    // new is used first (the context line), so it is document 0.
    expect(plan.texts).toEqual([NEW, OLD]);
    expect(where(plan)).toEqual([["0:0", "1:1", "0:1", "0:2"]]);
  });

  it("falls back to the hunk's own side for a line the whole side does not read the same", () => {
    // The working file moved on after the diff was read.
    const plan = diffHighlightPlan(parseDiff(ONE_HUNK), { old: OLD, new: "a\nX\nc\nd\n" }, fitsAll);
    expect(plan.texts).toEqual(["a\nX\nc\nd\n", OLD, "a\nB\nc"]);
    expect(where(plan)).toEqual([["0:0", "1:1", "2:1", "0:2"]]);
  });

  it("falls back where a side was not read, is cut short, or is too large to tokenize", () => {
    const missing = diffHighlightPlan(parseDiff(ONE_HUNK), { old: null, new: null }, fitsAll);
    expect(missing.texts).toEqual(["a\nB\nc", "a\nb\nc"]);
    expect(where(missing)).toEqual([["0:0", "1:1", "0:1", "0:2"]]);

    const capped = diffHighlightPlan(parseDiff(ONE_HUNK), { old: OLD, new: "a\n" }, fitsAll);
    expect(where(capped)).toEqual([["0:0", "1:1", "2:1", "1:2"]]);
    expect(capped.texts).toEqual(["a\n", OLD, "a\nB\nc"]);

    const tooBig = diffHighlightPlan(parseDiff(ONE_HUNK), { old: OLD, new: NEW }, () => false);
    expect(tooBig.texts).toEqual(["a\nB\nc", "a\nb\nc"]);
  });

  it("keeps each hunk's fallback to itself — nothing carries from one hunk to the next", () => {
    const raw = "@@ -1,2 +1,2 @@\n-x\n+y\n z\n@@ -9,2 +9,2 @@\n w\n-p\n+q\n";
    const plan = diffHighlightPlan(parseDiff(raw), { old: null, new: null }, fitsAll);
    expect(plan.texts).toEqual(["x\nz", "y\nz", "w\nq", "w\np"]);
  });

  it("forgives the CR a working file has where the diff shows none, and drops it from the colors", () => {
    const plan = diffHighlightPlan(parseDiff(ONE_HUNK), { old: OLD, new: "a\r\nB\r\nc\r\n" }, fitsAll);
    expect(plan.sources[0][2]).toEqual({ doc: 0, line: 1, dropCr: true });
    const docs: LineTokens[][] = [
      [[{ text: "a" }, { text: "\r" }], [{ text: "B", color: "#f00" }, { text: "\r" }], [{ text: "c\r" }]],
      [[], [], []],
    ];
    expect(lineTokens(plan, docs, 0, 2)).toEqual([{ text: "B", color: "#f00" }]);
    expect(lineTokens(plan, docs, 0, 0)).toEqual([{ text: "a" }]);
  });

  it("gives a meta line no colors, and no line any before the documents are tokenized", () => {
    const raw = "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n";
    const plan = diffHighlightPlan(parseDiff(raw), { old: "a", new: "b\n" }, fitsAll);
    expect(plan.sources[0][1]).toBeNull();
    expect(lineTokens(plan, null, 0, 0)).toBeUndefined();
  });

  it("reads an untracked file's all-added diff as the one document it is", () => {
    const plan = diffHighlightPlan(newFileDiff("x\ny\n"), { old: null, new: null }, fitsAll);
    expect(plan.texts).toEqual(["x\ny"]);
  });
});

// The real engine, through the real client: the two diffs that painted code
// as comment (task-497), reproduced from real `git diff` output. A real
// grammar by design — what it checks is a comment's state carried across
// lines, which no stand-in models (task-553) — so the budget is one cold
// compile's, paid on this file's first tokenize.
describe("diffHighlightPlan with the real highlighter", { timeout: 60_000 }, () => {
  const COMMENT = "#7F848E";
  const blanks = (n: number) => "\n".repeat(n);

  beforeAll(() => installInProcessWorker());

  async function colorsOf(raw: string, sides: { old: string | null; new: string | null }) {
    const diff = parseDiff(raw);
    const plan = diffHighlightPlan(diff, sides, fitsAll);
    const docs = await Promise.all(plan.texts.map((text) => tokenizeLines(text, "typescript")));
    const ready = docs.filter((doc) => doc !== null);
    expect(ready).toHaveLength(docs.length);
    /** The color of the keyword at the start of the line reading `text`. */
    return (text: string) => {
      for (const [h, hunk] of diff.hunks.entries()) {
        const i = hunk.lines.findIndex((line) => line.text === text);
        if (i >= 0) return lineTokens(plan, ready, h, i)?.[0]?.color;
      }
      throw new Error(`no line reads ${text}`);
    };
  }

  // A removed `/*` used to open a comment over the added line after it.
  const OPENER_REMOVED = `@@ -1,4 +1,4 @@\n-/*\n+const added = 1;\n \n \n \n@@ -9,5 +9,4 @@\n \n \n \n-*/\n const answer = 42;\n`;
  // The `*/` closing the comment sat in the gap git left out between hunks.
  const CLOSER_IN_GAP = `@@ -1,4 +1,4 @@\n-const start = 0;\n+const start = 1;\n /*\n \n \n@@ -17,4 +17,4 @@ const start = 0;\n \n \n \n-const later = 1;\n+const later = 2;\n`;

  it("reads code as code with both sides whole", async () => {
    const opener = await colorsOf(OPENER_REMOVED, {
      old: `/*${blanks(11)}*/\nconst answer = 42;\n`,
      new: `const added = 1;${blanks(11)}const answer = 42;\n`,
    });
    expect(opener("const added = 1;")).not.toBe(COMMENT);
    expect(opener("const answer = 42;")).not.toBe(COMMENT);
    expect(opener("/*")).toBe(COMMENT);

    const gap = await colorsOf(CLOSER_IN_GAP, {
      old: `const start = 0;\n/*${blanks(9)}*/${blanks(9)}const later = 1;\n`,
      new: `const start = 1;\n/*${blanks(9)}*/${blanks(9)}const later = 2;\n`,
    });
    expect(gap("const later = 2;")).not.toBe(COMMENT);
    expect(gap("const later = 1;")).not.toBe(COMMENT);
  });

  it("reads code as code from the hunks alone, when no side could be read", async () => {
    const opener = await colorsOf(OPENER_REMOVED, { old: null, new: null });
    expect(opener("const added = 1;")).not.toBe(COMMENT);
    const gap = await colorsOf(CLOSER_IN_GAP, { old: null, new: null });
    expect(gap("const later = 2;")).not.toBe(COMMENT);
  });
});
