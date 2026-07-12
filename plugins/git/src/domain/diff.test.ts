import { describe, expect, it } from "vitest";
import {
  flatLines,
  hunkOffsets,
  isEmptyDiff,
  newFileDiff,
  parseDiff,
} from "./diff";

const SAMPLE = `diff --git a/src/main.ts b/src/main.ts
index 1111111..2222222 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,4 +1,4 @@
 import { app } from "./app";
-const port = 3000;
+const port = 4000;
 app.listen(port);
@@ -10,2 +10,3 @@ function shutdown() {
   close();
+  flush();
 }
`;

describe("parseDiff", () => {
  it("drops the preamble and splits hunks with correct dual line numbers", () => {
    const diff = parseDiff(SAMPLE);

    expect(diff.binary).toBe(false);
    expect(diff.hunks).toHaveLength(2);

    const [first, second] = diff.hunks;
    expect(first.header).toBe("@@ -1,4 +1,4 @@");
    expect(first.lines.map((l) => l.kind)).toEqual([
      "context",
      "del",
      "add",
      "context",
    ]);
    // The deleted line numbers only on the old side, the added only on the new;
    // context advances both.
    expect(first.lines[1]).toMatchObject({ oldNo: 2, newNo: null });
    expect(first.lines[2]).toMatchObject({ oldNo: null, newNo: 2 });
    expect(first.lines[3]).toMatchObject({ oldNo: 3, newNo: 3 });

    // The second hunk restarts numbering from its own @@ header.
    expect(second.lines[0]).toMatchObject({ kind: "context", oldNo: 10, newNo: 10 });
    expect(second.lines[1]).toMatchObject({ kind: "add", newNo: 11 });

    // Markers are stripped from the text.
    expect(first.lines[1].text).toBe("const port = 3000;");
  });

  it("flags a binary diff and keeps the no-newline note as a meta line", () => {
    expect(
      parseDiff("Binary files a/logo.png and b/logo.png differ\n").binary,
    ).toBe(true);

    const noEol = parseDiff(
      "@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n",
    );
    const lines = noEol.hunks[0].lines;
    const last = lines[lines.length - 1];
    expect(last?.kind).toBe("meta");
    expect(last?.text).toContain("No newline");
  });

  it("an empty diff parses to an empty model", () => {
    const diff = parseDiff("");
    expect(diff.hunks).toHaveLength(0);
    expect(isEmptyDiff(diff)).toBe(true);
  });
});

describe("flatLines / hunkOffsets", () => {
  it("flatten hunks in render order and index them back", () => {
    const diff = parseDiff(
      "@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -9 +9 @@\n-z\n+Z\n\\ No newline at end of file\n",
    );
    const flat = flatLines(diff);
    const offsets = hunkOffsets(diff);
    expect(flat).toEqual(["a", "b", "B", "z", "Z", "\\ No newline at end of file"]);
    expect(offsets).toEqual([0, 3]);
    // The renderer's mapping: hunk h, line i → flat[offsets[h] + i].
    expect(flat[offsets[1] + 1]).toBe("Z");
  });

  it("handle an empty diff", () => {
    const diff = parseDiff("");
    expect(flatLines(diff)).toEqual([]);
    expect(hunkOffsets(diff)).toEqual([]);
  });
});

describe("newFileDiff", () => {
  it("renders plain content as one all-added hunk with new-side numbers", () => {
    const diff = newFileDiff("first\nsecond\n");
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0].lines).toEqual([
      { kind: "add", text: "first", oldNo: null, newNo: 1 },
      { kind: "add", text: "second", oldNo: null, newNo: 2 },
    ]);
    expect(isEmptyDiff(diff)).toBe(false);
  });
});
