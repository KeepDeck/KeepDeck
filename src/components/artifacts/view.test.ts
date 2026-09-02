import { describe, expect, it } from "vitest";
import type { ArtifactMetaRow } from "../../ipc/artifacts";
import { viewOf } from "./view";

const row = (id: string): ArtifactMetaRow => ({
  id,
  title: `The ${id}`,
  versionCount: 2,
  updatedAt: 1_700_000_000_000,
  lastAuthor: "support 1",
  generation: `gen-${id}`,
});

describe("viewOf", () => {
  // The classification, by its inputs: five states that look alike from
  // the outside, and the ordering between two of them that matters.
  const cases: Array<{
    when: string;
    ws: string | null;
    rows: readonly ArtifactMetaRow[] | null;
    error: string | null;
    kind: string;
  }> = [
    { when: "no workspace", ws: null, rows: null, error: null, kind: "noWorkspace" },
    { when: "the read is still out", ws: "ws-1", rows: null, error: null, kind: "loading" },
    { when: "rows landed", ws: "ws-1", rows: [row("a")], error: null, kind: "rows" },
    { when: "the store refused", ws: "ws-1", rows: [], error: "off", kind: "refusal" },
    { when: "the workspace is empty", ws: "ws-1", rows: [], error: null, kind: "empty" },
    // The ordering: a failure that arrives while rows are up must not
    // blank them — the banner carries it and the list stays readable.
    { when: "a read failed with rows up", ws: "ws-1", rows: [row("a")], error: "off", kind: "rows" },
  ];

  for (const { when, ws, rows, error, kind } of cases) {
    it(`is ${kind} when ${when}`, () => {
      expect(viewOf(ws, rows, error).kind).toBe(kind);
    });
  }
});
