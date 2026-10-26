// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHighlights } from "./useHighlight";
import { tokenizeLines } from "./highlighter";
import { MAX_HIGHLIGHT_LINE_CHARS } from "./limits";
import type { LineTokens } from "./tokens";

/** One run per line, colored by the text — enough to tell documents apart. */
vi.mock("./highlighter", () => ({
  tokenizeLines: vi.fn(async (text: string, lang: string) =>
    lang === "none" ? null : text.split("\n").map((line) => [{ text: line, color: `#${line}` }]),
  ),
}));

describe("useHighlights", () => {
  let root: Root;
  let seen: (LineTokens[][] | null)[];

  function Probe({ texts, lang }: { texts: readonly string[] | null; lang: string | null }) {
    seen.push(useHighlights(texts, lang));
    return null;
  }

  const render = async (texts: readonly string[] | null, lang: string | null = "ts") => {
    await act(async () => root.render(createElement(Probe, { texts, lang })));
    await act(async () => {});
  };
  const last = () => seen[seen.length - 1];

  beforeEach(() => {
    seen = [];
    vi.mocked(tokenizeLines).mockClear();
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => {
    act(() => root.unmount());
  });

  it("is plain first, then every document's lines, in order", async () => {
    await render(["a\nb", "c"]);
    expect(seen[0]).toBeNull();
    expect(last()).toEqual([
      [[{ text: "a", color: "#a" }], [{ text: "b", color: "#b" }]],
      [[{ text: "c", color: "#c" }]],
    ]);
  });

  it("tokenizes again only when a text changes, not when the array is rebuilt", async () => {
    await render(["a", "b"]);
    await render(["a", "b"]);
    expect(tokenizeLines).toHaveBeenCalledTimes(2);
    await render(["a", "c"]);
    expect(tokenizeLines).toHaveBeenCalledTimes(4);
    expect(last()?.[1]).toEqual([[{ text: "c", color: "#c" }]]);
  });

  it("never shows the previous texts' colors for new ones", async () => {
    await render(["a"]);
    let resolve: (lines: LineTokens[]) => void = () => {};
    vi.mocked(tokenizeLines).mockImplementationOnce(
      () => new Promise((done) => (resolve = done)),
    );
    await render(["b"]);
    expect(last()).toBeNull();
    await act(async () => resolve([[{ text: "b" }]]));
    expect(last()).toEqual([[[{ text: "b" }]]]);
  });

  it("is all or nothing: one document over the limits leaves every one plain", async () => {
    await render(["a", "x".repeat(MAX_HIGHLIGHT_LINE_CHARS + 1)]);
    expect(tokenizeLines).not.toHaveBeenCalled();
    expect(last()).toBeNull();
  });

  it("stays plain for no documents, no language, or one the kit didn't load", async () => {
    await render([]);
    await render(["a"], null);
    await render(["a"], "none");
    expect(seen.every((value) => value === null)).toBe(true);
  });
});
