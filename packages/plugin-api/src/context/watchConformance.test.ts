import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { watchMatches, watchProject, type TailWatch } from "./sessionTail";

/**
 * This side of the conformance corpus.
 *
 * A watch is WRITTEN here, in TypeScript, and APPLIED by the host, in Rust.
 * The types are a wire contract and cannot be merged — but the semantics can
 * drift, and that is the real hazard: one side growing a trim, a coercion or
 * a looser notion of presence while the other never hears about it. Both
 * suites read the same file, so a rule stated in one language has to be
 * satisfied in both or the build says so.
 *
 * The Rust half lives in `src-tauri/src/session_tail/dialects.rs` and binds
 * the same path with `include_str!`, which makes a moved or deleted corpus a
 * compile error rather than a silently skipped test.
 */
interface Case {
  readonly name: string;
  readonly watches: readonly TailWatch[];
  readonly record: Record<string, unknown>;
  readonly carried: { readonly watch: number; readonly record: unknown } | null;
}

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../conformance/watch-cases.json", import.meta.url)),
    "utf8",
  ),
) as { cases: Case[] };

/** What this side does with a record, in the shape the corpus states. */
function carry(
  watches: readonly TailWatch[],
  record: Record<string, unknown>,
): { watch: number; record: unknown } | null {
  const index = watches.findIndex((watch) => watchMatches(watch, record));
  if (index === -1) return null;
  return { watch: index, record: watchProject(watches[index]!, record) };
}

describe("watch descriptor conformance", () => {
  it("has cases to run", () => {
    // A corpus that silently emptied would let both sides pass while
    // agreeing on nothing.
    expect(corpus.cases.length).toBeGreaterThan(15);
  });

  for (const testCase of corpus.cases) {
    it(testCase.name, () => {
      expect(carry(testCase.watches, testCase.record)).toEqual(
        testCase.carried,
      );
    });
  }
});
