import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No TypeScript file casts through `unknown`.
 *
 * `x as unknown as T` tells the compiler to stop checking: whatever `x` is,
 * it is now `T`. In this codebase it was almost always a test building half
 * of something too wide — a whole PluginContext, a whole Deck — and casting
 * the rest into existence; a member the code started to use then went
 * missing from the double without a word from the compiler (task-433 found
 * fakes answering a file with only its text). The fix is a narrower port or
 * one typed fake, never the cast — so a new one fails here.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["src", "packages", "plugins"];
const SOURCE = /\.(ts|tsx)$/;
const SKIP = new Set(["node_modules", "dist", "gen"]);
// Across line breaks too: a formatter may wrap the cast.
const DOUBLE_CAST = /\bas\s+unknown\s+as\b/g;

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (SOURCE.test(entry.name)) yield path;
  }
}

describe("TypeScript sources", () => {
  it("never cast through unknown", () => {
    const casts = [];
    let seen = 0;
    for (const root of ROOTS) {
      for (const path of sources(join(REPO, root))) {
        seen += 1;
        const text = readFileSync(path, "utf8");
        for (const cast of text.matchAll(DOUBLE_CAST)) {
          const line = text.slice(0, cast.index).split("\n").length;
          casts.push(`${relative(REPO, path)}:${line}`);
        }
      }
    }
    // A walk that found nothing proves nothing.
    expect(seen).toBeGreaterThan(500);
    expect(casts).toEqual([]);
  });
});
