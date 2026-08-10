import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every source file has to stay TEXT.
 *
 * A single NUL byte makes git classify a file as binary, and a binary file is
 * invisible to `git diff`, `git log -p`, `git blame -L`, PR review and every
 * text-based scan. It happened here: a separator written as a raw 0x00
 * instead of `\0` hid an entire security fix from review — the change was
 * correct, and nobody could have read it.
 *
 * The escape and the byte are the same value at runtime, so nothing is lost
 * by requiring the escape.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["src", "packages", "plugins", "scripts", "crates", "src-tauri/src"];
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|rs|sh|css|json|md)$/;
const SKIP = new Set(["node_modules", "dist", "target", "gen", ".git"]);

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (SOURCE.test(entry.name)) yield path;
  }
}

describe("source files", () => {
  it("carry no NUL byte, so git never calls one binary", () => {
    const binary = [];
    let seen = 0;
    for (const root of ROOTS) {
      for (const path of sources(join(REPO, root))) {
        seen += 1;
        if (readFileSync(path).includes(0)) binary.push(relative(REPO, path));
      }
    }
    // A roster check too: reading nothing would make the assertion vacuous.
    expect(seen).toBeGreaterThan(500);
    expect(binary, "write the escape (\\0), not the byte").toEqual([]);
  });
});
