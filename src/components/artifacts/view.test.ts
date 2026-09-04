import { describe, expect, it } from "vitest";
import type { ArtifactMetaRow } from "../../ipc/artifacts";
import { matching, viewOf } from "./view";

const row = (id: string): ArtifactMetaRow => ({
  id,
  title: `The ${id}`,
  versionCount: 2,
  updatedAt: 1_700_000_000_000,
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
      expect(viewOf(ws, rows, error, "").kind).toBe(kind);
    });
  }
});

describe("searching a workspace's artifacts", () => {
  const rows = [
    row("auth-flow"),
    row("deck-layout"),
  ].map((r, i) => ({ ...r, title: ["The auth flow", "Deck layout"][i] }));

  it("matches a title or an id, case-insensitively", () => {
    // The id is searched beside the title because it is the half people
    // are given and the half they type.
    expect(matching(rows, "AUTH").map((r) => r.id)).toEqual(["auth-flow"]);
    expect(matching(rows, "layout").map((r) => r.id)).toEqual(["deck-layout"]);
    expect(matching(rows, "deck-lay").map((r) => r.id)).toEqual(["deck-layout"]);
  });

  it("an empty query is not a filter", () => {
    expect(matching(rows, "   ")).toBe(rows);
  });

  it("tells an empty workspace apart from an empty search", () => {
    // The distinction is the only thing that says whose fault the blank
    // screen is.
    expect(viewOf("ws-1", rows, null, "zzz")).toEqual({
      kind: "noMatch",
      query: "zzz",
      banner: null,
    });
    expect(viewOf("ws-1", [], null, "zzz").kind).toBe("empty");
  });
});

describe("a failed read while a list is in hand", () => {
  const rows = [row("auth-flow")];

  it("never takes the list away, matched or not", () => {
    // The trap this closes: a failed refresh under a query that matches
    // nothing used to answer `refusal`, which unmounts the search box —
    // stranding the user with a query they could no longer clear.
    expect(viewOf("ws-1", rows, "read failed", "").kind).toBe("rows");
    expect(viewOf("ws-1", rows, "read failed", "zzz")).toEqual({
      kind: "noMatch",
      query: "zzz",
      banner: "read failed",
    });
  });

  it("is the whole body only when there is no list at all", () => {
    expect(viewOf("ws-1", [], "read failed", "zzz").kind).toBe("refusal");
  });
});
