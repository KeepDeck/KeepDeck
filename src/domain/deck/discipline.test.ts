/**
 * Deck discipline: a pane's directory has ONE formula, `paneExecutionCwd` in
 * `roots.ts`, and nothing in `src/app` or `src/domain` spells its own.
 *
 * A guard, not a proof. It catches the two shapes a copy has taken — the
 * coalescence `?? ws.cwd` and the ternary on the attached variant — and it
 * is deliberately narrow: `||`, a re-invented rule, or a fallback moved into
 * a helper all walk past it. What it buys is that every copy has to be made
 * on purpose and named here, the way the journal's is: that line was found
 * by this very search after two audits had read past it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));

/** The one copy allowed to stand, with the reason it may: the journal wants
 * a workspace attribution and the path it runs on never sees a null. */
const ALLOWED = new Map([
  ["domain/deck/reducer.ts", "cwd: paneExecutionCwd(ws, pane) ?? ws.cwd,"],
]);

const COPIES = [
  /\?\?\s*(?:ws|workspace)\.cwd\b/,
  /kind === "attached"\s*\?\s*[\w.]+\.cwd\s*:\s*(?:ws|workspace)\.cwd\b/,
];

function productionSources(area: "app" | "domain"): string[] {
  return readdirSync(`${SRC}${area}`, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name))
    .filter((name) => !/\.test\.tsx?$/.test(name) && !/testSupport\.tsx?$/.test(name))
    .map((name) => `${area}/${name}`);
}

describe("a pane's directory has one formula", () => {
  const files = [...productionSources("app"), ...productionSources("domain")];

  it("scans a tree that is actually there", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("domain/deck/roots.ts");
  });

  it.each(files)("%s spells no copy of it", (file) => {
    const source = readFileSync(`${SRC}${file}`, "utf8");
    const allowed = ALLOWED.get(file);
    for (const [number, line] of source.split("\n").entries()) {
      if (allowed !== undefined && line.includes(allowed)) continue;
      for (const copy of COPIES) {
        expect(
          line,
          `${file}:${number + 1} derives a pane's directory itself — read paneExecutionCwd instead`,
        ).not.toMatch(copy);
      }
    }
  });

  it("keeps its allowance honest — the journal line it names is still there", () => {
    // An allowance that outlives its line would let the next copy in
    // unremarked; the day the journal stops coalescing, this entry goes.
    for (const [file, line] of ALLOWED) {
      expect(readFileSync(`${SRC}${file}`, "utf8")).toContain(line);
    }
  });
});
