import { describe, expect, it, vi } from "vitest";
import { langsToWarm, warmHighlighter } from "./warm";
import { warmLanguage } from "./highlighter";

vi.mock("./highlighter", () => ({ warmLanguage: vi.fn() }));

describe("langsToWarm", () => {
  it("names each known language once, in a stable order, and drops the unknown", () => {
    expect(langsToWarm(["b.ts", "a.rs", "c.ts", "README", "x.unknown", "Dockerfile"])).toEqual([
      "docker",
      "rust",
      "typescript",
    ]);
    expect(langsToWarm([])).toEqual([]);
  });
});

describe("warmHighlighter", () => {
  it("warms the instance before any grammar", () => {
    warmHighlighter(["rust", "typescript"]);
    expect(vi.mocked(warmLanguage).mock.calls).toEqual([[null], ["rust"], ["typescript"]]);
  });
});
