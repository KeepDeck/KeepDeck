import { describe, expect, it } from "vitest";
import type { ArtifactMetaRow } from "../../app/artifacts/registryRead";
import { artifactRowKey, matching, placeholderView, viewOf } from "./view";

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

describe("a row's identity in the windowed list", () => {
  it("is the artifact's id, so two artifacts of one title never share a measured height", () => {
    // Titles repeat — agents republish under the same words — and a key
    // shared by two rows would hand one's measured height, an open
    // history's included, to the other.
    const twins = [
      { ...row("plan-v1"), title: "Plan" },
      { ...row("plan-v2"), title: "Plan" },
    ];
    expect(twins.map(artifactRowKey)).toEqual(["plan-v1", "plan-v2"]);
  });
});

describe("placeholderView", () => {
  const headline = (text: string) => ({
    text,
    className: "artifacts__placeholder-title",
    role: undefined,
  });

  it("names the missing workspace and what to do about it", () => {
    expect(placeholderView({ kind: "noWorkspace" })).toEqual({
      title: headline("No workspace open"),
      detail: "Artifacts belong to a workspace — open one first",
    });
  });

  it("says loading as one quiet line, with no headline", () => {
    expect(placeholderView({ kind: "loading" })).toEqual({
      title: null,
      detail: "Loading…",
    });
  });

  it("announces a refusal in the store's own words, selectable for a report", () => {
    expect(
      placeholderView({ kind: "refusal", message: "store is locked" }),
    ).toEqual({
      title: {
        text: "store is locked",
        className: "artifacts__placeholder-title kd-selectable",
        role: "alert",
      },
      detail: null,
    });
  });

  it("quotes the query back, and says the workspace is not empty", () => {
    // The second line is the whole difference from an empty workspace:
    // it tells the user the search, not the workspace, came up empty.
    expect(
      placeholderView({ kind: "noMatch", query: "auth", banner: null }),
    ).toEqual({
      title: headline("Nothing matches “auth”"),
      detail: "This workspace has artifacts; none of them by that name",
    });
  });

  it("explains an empty workspace by what would fill it", () => {
    expect(placeholderView({ kind: "empty" })).toEqual({
      title: headline("Nothing published yet"),
      detail:
        "Agents publish pages here; they open in your browser and refresh themselves as the agent iterates",
    });
  });
});
