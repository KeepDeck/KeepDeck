import { describe, expect, it } from "vitest";
import { installTokenWorker } from "./testing";
import { tokenizeLines } from "./highlighter";

/** The surface tests that color through the stand-in trust it to keep every
 * character where the text had it — the alignment the real engine keeps. */
describe("installTokenWorker", () => {
  it("answers through the real client with each line's own text, in runs of more than one color", async () => {
    const asked = installTokenWorker();
    const text = 'const s = "hi"\n\n  indented\tline ';

    const lines = await tokenizeLines(text, "typescript");

    expect(lines?.map((line) => line.map((run) => run.text).join(""))).toEqual(text.split("\n"));
    expect(lines?.[1]).toEqual([]);
    expect(new Set(lines?.[0].map((run) => run.color)).size).toBeGreaterThan(1);
    expect(asked).toEqual([{ text, lang: "typescript" }]);
  });

  it("keeps one record across installs, as the client keeps the worker it spawned", async () => {
    const before = installTokenWorker().length;
    await tokenizeLines("after", "rust");

    expect(installTokenWorker().slice(before)).toEqual([{ text: "after", lang: "rust" }]);
  });
});
