import { beforeAll, describe, expect, it, vi } from "vitest";
import { tokenize, warm } from "./engine";
import { present } from "@keepdeck/plugin-api/testing";

/**
 * These run the REAL grammars through the real Oniguruma engine — the kit's
 * contract is exactly the part a fake would hide: that the engine's output,
 * after alignment, reconstructs the viewer's lines byte for byte.
 */
// The instance — every grammar registered — is this file's one cold cost,
// paid once before its cases rather than inside the first of them.
beforeAll(() => warm(null));

describe("the engine's tokenize", () => {
  it("returns one entry per split line, reconstructing each verbatim", async () => {
    const text = 'const x: number = 1\n\nexport function f() {\n  return "s"\n}\n';
    const lines = await tokenize(text, "typescript");
    expect(lines).not.toBeNull();
    const raw = text.split("\n");
    expect(present(lines, "the highlighted lines").length).toBe(raw.length);
    for (let i = 0; i < raw.length; i++) {
      expect(present(lines, "the highlighted lines")[i].map((run) => run.text).join("")).toBe(raw[i]);
    }
  });

  it("actually colors code (not one monochrome run per line)", async () => {
    const lines = await tokenize('const s = "hi" // note', "typescript");
    expect(lines).not.toBeNull();
    const colors = new Set(present(lines, "the highlighted lines")[0].map((run) => run.color));
    // Keyword vs string vs comment must differ — that's the whole feature.
    expect(colors.size).toBeGreaterThan(1);
  });

  it("keeps CRLF text byte-identical to the plain path", async () => {
    const text = "const a = 1\r\nlet b = 2\r\n";
    const lines = await tokenize(text, "typescript");
    expect(lines).not.toBeNull();
    const raw = text.split("\n");
    expect(present(lines, "the highlighted lines").length).toBe(raw.length);
    for (let i = 0; i < raw.length; i++) {
      expect(present(lines, "the highlighted lines")[i].map((run) => run.text).join("")).toBe(raw[i]);
    }
  });

  it("returns null for a language the kit did not load", async () => {
    expect(await tokenize("whatever", "brainfuck")).toBeNull();
  });

  it("accepts grammar aliases — what a Markdown fence names", async () => {
    // "bash" aliases shellscript, "ts" aliases typescript; fences say these.
    expect(await tokenize("echo hi", "bash")).not.toBeNull();
    expect(await tokenize("const x = 1", "ts")).not.toBeNull();
    expect(await tokenize("x = 1", "py")).not.toBeNull();
  });

  it("never stops a slow line part-way and carries its comment state on", async () => {
    // A line that overruns a time limit comes back with the rule stack it
    // stopped in. Stopped just past a comment's opener, everything after it
    // read as comment — on a cold grammar in the webview, the first line took
    // longer than Shiki's default 500 ms. The clock here says every line took
    // 600 ms.
    const text = "/** One-line doc. */\nexport const answer = 1;\n/** Next doc. */\nexport const after = 2;";
    const plain = present(await tokenize(text, "typescript"), "the highlighted lines");
    let calls = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (calls++ < 2 ? 0 : 600));
    try {
      const slow = present(await tokenize(text, "typescript"), "the highlighted lines");
      expect(slow).toEqual(plain);
    } finally {
      clock.mockRestore();
    }
    // The code lines are code: the keyword is not the comment's color.
    const comment = plain[0][0].color;
    expect(plain[1].find((run) => run.text === "export")?.color).not.toBe(comment);
  });
});

describe("the engine's warm", () => {
  it("compiles a loaded grammar and passes over what the kit didn't load", async () => {
    await expect(warm(null)).resolves.toBeUndefined();
    await expect(warm("ini")).resolves.toBeUndefined();
    await expect(warm("brainfuck")).resolves.toBeUndefined();
  });
});
