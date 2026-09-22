/**
 * Domain discipline: the artifacts module stays pure — every import in
 * these files resolves inside `src/domain`. A stray import from
 * `src/app`, `src/ipc`, or a framework would make the "rules without IO"
 * claim a lie the compiler cannot catch. Relative is not enough:
 * `../../app/…` is relative too, and the check once passed it.
 *
 * And the CONSUMPTION half of the discipline: a domain module nothing
 * imports is dead code wearing architecture clothes — the whole module
 * once shipped with zero production importers while its 70 tests stayed
 * green (the three-homes drift lesson). This file asserts the wire
 * exists: the command layer imports the validators, so deleting or
 * orphaning the domain fails THIS test, not a code review.
 */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FILES = ["model.ts", "publish.ts", "delete.ts", "rowRef.ts"] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const DOMAIN = resolve(HERE, "..");

describe("domain/artifacts imports stay inside the domain", () => {
  it.each(FILES)("%s imports nothing outside the domain", (file) => {
    const source = readFileSync(
      fileURLToPath(new URL(`./${file}`, import.meta.url)),
      "utf8",
    );
    const imports = [
      ...source.matchAll(/from\s+"([^"]+)"/g),
      ...source.matchAll(/import\s+"([^"]+)"/g),
    ];
    for (const [, specifier] of imports) {
      const inside =
        specifier.startsWith(".") &&
        !relative(DOMAIN, resolve(HERE, specifier)).startsWith("..");
      expect(
        inside,
        `${file} imports ${specifier} — domain files may only import from src/domain`,
      ).toBe(true);
    }
  });
});

describe("domain/artifacts is CONSUMED by production", () => {
  const CONSUMERS: { file: string; imports: string[] }[] = [
    {
      file: "../../app/artifacts/artifactCommands.ts",
      imports: ["isArtifactFormat", "validateTitle"],
    },
    {
      file: "../../components/artifacts/useArtifactsRegistry.ts",
      imports: ["fateOf"],
    },
  ];

  it.each(CONSUMERS.map((c) => [c.file, c.imports] as const))(
    "%s imports its domain rules",
    (file, wanted) => {
      const source = readFileSync(
        fileURLToPath(new URL(`./${file}`, import.meta.url)),
        "utf8",
      );
      const importBlock = source.slice(0, source.indexOf("export "));
      for (const name of wanted) {
        expect(
          new RegExp(`\\b${name}\\b`).test(importBlock),
          `${file} must import ${name} from the domain (the one-home rule; inline literals are how the drift shipped)`,
        ).toBe(true);
      }
    },
  );
});
