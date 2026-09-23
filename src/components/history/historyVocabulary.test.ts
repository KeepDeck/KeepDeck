import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const mask = /block|divider|section/i;

// These are ordinary English uses, not remnants of the removed two-list
// vocabulary: a missing directory blocks Resume. Every other hit in the
// production scope needs an explicit, current meaning.
const liveUses: Array<{ path: string; text: RegExp }> = [
  { path: "src/components/history/useDirPresence.ts", text: /would block$/i },
  { path: "src/components/history/SessionRowView.tsx", text: /blocks Resume/i },
  { path: "src/components/history/SessionRowView.tsx", text: /Resume is blocked/i },
];

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(?:css|ts|tsx)$/.test(entry.name)) return [];
    if (/\.test(?:\.|-support\.)/.test(entry.name)) return [];
    return [path];
  });
}

function staleVocabularyHits(): string[] {
  const roots = [
    resolve(repoRoot, "src/components/history"),
    resolve(repoRoot, "src/domain/journal"),
  ];
  const files = [...roots.flatMap(sourceFiles), resolve(repoRoot, "src/styles/history.css")];
  const hits: string[] = [];
  for (const file of files) {
    const path = relative(repoRoot, file);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (!mask.test(line)) return;
        const allowed = liveUses.some(
          (use) => use.path === path && use.text.test(line),
        );
        if (!allowed) hits.push(`${path}:${index + 1}: ${line.trim()}`);
      });
  }
  return hits;
}

describe("session-list vocabulary witness", () => {
  it("finds no removed block/divider/section vocabulary in production history code", () => {
    expect(statSync(resolve(repoRoot, "src/components/history")).isDirectory()).toBe(true);
    expect(staleVocabularyHits()).toEqual([]);
  });
});
