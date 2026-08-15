/**
 * Domain discipline: the artifacts module stays pure — every import in
 * these files is `../`-local (the domain/status precedent). A stray
 * import from `src/app`, `src/ipc`, or a framework would make the
 * "rules without IO" claim a lie the compiler cannot catch.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FILES = ["model.ts", "publish.ts", "delete.ts"] as const;

describe("domain/artifacts imports stay ../-local", () => {
  it.each(FILES)("%s imports nothing outside the domain", (file) => {
    const source = readFileSync(
      fileURLToPath(new URL(`./${file}`, import.meta.url)),
      "utf8",
    );
    const imports = [
      ...source.matchAll(/from\s+"([^"]+)"/g),
      ...source.matchAll(/import\s+"([^"]+)"/g),
    ];
    expect(imports.length).toBeGreaterThanOrEqual(0);
    for (const [, specifier] of imports) {
      expect(
        specifier.startsWith("./") || specifier.startsWith("../"),
        `${file} imports ${specifier} — domain files may only import relatively`,
      ).toBe(true);
    }
  });
});
