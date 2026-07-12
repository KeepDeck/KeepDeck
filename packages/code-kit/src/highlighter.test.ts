import { describe, expect, it } from "vitest";
import { tokenizeLines } from "./highlighter";

/**
 * These run the REAL grammars through the real JS regex engine — the kit's
 * contract is exactly the part a fake would hide: that the engine's output,
 * after alignment, reconstructs the viewer's lines byte for byte.
 */
describe("tokenizeLines", () => {
  it("returns one entry per split line, reconstructing each verbatim", async () => {
    const text = 'const x: number = 1\n\nexport function f() {\n  return "s"\n}\n';
    const lines = await tokenizeLines(text, "typescript");
    expect(lines).not.toBeNull();
    const raw = text.split("\n");
    expect(lines!.length).toBe(raw.length);
    for (let i = 0; i < raw.length; i++) {
      expect(lines![i].map((run) => run.text).join("")).toBe(raw[i]);
    }
  });

  it("actually colors code (not one monochrome run per line)", async () => {
    const lines = await tokenizeLines('const s = "hi" // note', "typescript");
    expect(lines).not.toBeNull();
    const colors = new Set(lines![0].map((run) => run.color));
    // Keyword vs string vs comment must differ — that's the whole feature.
    expect(colors.size).toBeGreaterThan(1);
  });

  it("keeps CRLF text byte-identical to the plain path", async () => {
    const text = "const a = 1\r\nlet b = 2\r\n";
    const lines = await tokenizeLines(text, "typescript");
    expect(lines).not.toBeNull();
    const raw = text.split("\n");
    expect(lines!.length).toBe(raw.length);
    for (let i = 0; i < raw.length; i++) {
      expect(lines![i].map((run) => run.text).join("")).toBe(raw[i]);
    }
  });

  it("returns null for a language the kit did not load", async () => {
    expect(await tokenizeLines("whatever", "brainfuck")).toBeNull();
  });

  it("accepts grammar aliases — what a Markdown fence names", async () => {
    // "bash" aliases shellscript, "ts" aliases typescript; fences say these.
    expect(await tokenizeLines("echo hi", "bash")).not.toBeNull();
    expect(await tokenizeLines("const x = 1", "ts")).not.toBeNull();
    expect(await tokenizeLines("x = 1", "py")).not.toBeNull();
  });

  it("covers every id the path mapping can produce", async () => {
    // langFor's ids form a closed set; each must resolve to a loaded grammar,
    // or a file of that type silently loses color one day.
    const { langFor } = await import("./lang");
    const samples = [
      "a.ts", "a.tsx", "a.js", "a.jsx", "a.json", "a.jsonc", "a.rs", "a.toml",
      "a.yaml", "a.md", "a.html", "a.css", "a.scss", "a.less", "a.sh", "a.py",
      "a.go", "a.java", "a.kt", "a.swift", "a.c", "a.cpp", "a.cs", "a.rb",
      "a.php", "a.sql", "a.xml", "a.diff", "a.ini", "a.graphql", "a.lua",
      "a.vue", "a.svelte", "a.m", "a.pl", "Dockerfile", "Makefile",
    ];
    for (const sample of samples) {
      const lang = langFor(sample);
      expect(lang, sample).not.toBeNull();
      expect(await tokenizeLines("x", lang!), `${sample} -> ${lang}`).not.toBeNull();
    }
  });
});
