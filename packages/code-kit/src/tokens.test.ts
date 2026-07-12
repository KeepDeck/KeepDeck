import { describe, expect, it } from "vitest";
import { alignTokens, type ThemedTokenLike } from "./tokens";

const t = (content: string, color?: string): ThemedTokenLike =>
  color ? { content, color } : { content };

describe("alignTokens", () => {
  it("keeps colored runs when they reconstruct the line verbatim", () => {
    const lines = ["const x = 1", "return x"];
    const themed = [
      [t("const", "#c678dd"), t(" x = ", "#abb2bf"), t("1", "#d19a66")],
      [t("return", "#c678dd"), t(" x", "#abb2bf")],
    ];
    expect(alignTokens(lines, themed)).toEqual([
      [
        { text: "const", color: "#c678dd" },
        { text: " x = ", color: "#abb2bf" },
        { text: "1", color: "#d19a66" },
      ],
      [
        { text: "return", color: "#c678dd" },
        { text: " x", color: "#abb2bf" },
      ],
    ]);
  });

  it("falls back to one plain run when tokens do not reconstruct the line", () => {
    const lines = ["let a = 1", "let b = 2"];
    const themed = [
      [t("let a = 1")], // fine
      [t("let b"), t(" = 3")], // drifted — concat says "let b = 3"
    ];
    const aligned = alignTokens(lines, themed);
    expect(aligned[0]).toEqual([{ text: "let a = 1" }]);
    // Only the drifted line degrades; content wins over color.
    expect(aligned[1]).toEqual([{ text: "let b = 2" }]);
  });

  it("re-attaches the CR that CRLF splitting leaves on the viewer's lines", () => {
    const lines = ["const a = 1\r", "done"];
    const themed = [
      [t("const", "#c678dd"), t(" a = 1", "#abb2bf")], // engine dropped the \r
      [t("done")],
    ];
    const aligned = alignTokens(lines, themed);
    expect(aligned[0]).toEqual([
      { text: "const", color: "#c678dd" },
      { text: " a = 1", color: "#abb2bf" },
      { text: "\r" },
    ]);
    // The rendered text must stay byte-identical to the plain path.
    expect(aligned[0].map((run) => run.text).join("")).toBe(lines[0]);
  });

  it("renders a missing engine line as plain and ignores surplus ones", () => {
    const lines = ["one", "two"];
    expect(alignTokens(lines, [[t("one")]])).toEqual([
      [{ text: "one" }],
      [{ text: "two" }],
    ]);
    expect(alignTokens(["one"], [[t("one")], [t("ghost")]])).toEqual([
      [{ text: "one" }],
    ]);
  });

  it("normalizes empty lines and empty tokens to the empty-run marker", () => {
    // Shiki emits [{content: ""}] for an empty line; the renderer's
    // empty-array contract (→ height-preserving space) must see [].
    expect(alignTokens(["", "x"], [[t("")], [t("x")]])).toEqual([
      [],
      [{ text: "x" }],
    ]);
  });

  it("carries the italic font-style bit onto the run", () => {
    const themed: ThemedTokenLike[][] = [
      [{ content: "// note", color: "#5c6370", fontStyle: 1 }],
    ];
    expect(alignTokens(["// note"], themed)).toEqual([
      [{ text: "// note", color: "#5c6370", italic: true }],
    ]);
  });
});
