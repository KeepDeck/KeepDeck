import { describe, expect, it } from "vitest";
import { deleteQuestion, placeholderWords } from "./words";

describe("placeholderWords", () => {
  it("names the missing workspace and what to do about it", () => {
    expect(placeholderWords({ kind: "noWorkspace" })).toEqual({
      title: "No workspace open",
      detail: "Artifacts belong to a workspace — open one first",
      alert: false,
    });
  });

  it("says loading as one quiet line, with no headline", () => {
    expect(placeholderWords({ kind: "loading" })).toEqual({
      title: null,
      detail: "Loading…",
      alert: false,
    });
  });

  it("gives a refusal the store's own words, announced", () => {
    expect(
      placeholderWords({ kind: "refusal", message: "store is locked" }),
    ).toEqual({ title: "store is locked", detail: null, alert: true });
  });

  it("quotes the query back, and says the workspace is not empty", () => {
    // The second line is the whole difference from an empty workspace:
    // it tells the user the search, not the workspace, came up empty.
    expect(
      placeholderWords({ kind: "noMatch", query: "auth", banner: null }),
    ).toEqual({
      title: "Nothing matches “auth”",
      detail: "This workspace has artifacts; none of them by that name",
      alert: false,
    });
  });

  it("explains an empty workspace by what would fill it", () => {
    expect(placeholderWords({ kind: "empty" })).toEqual({
      title: "Nothing published yet",
      detail:
        "Agents publish pages here; they open in your browser and refresh themselves as the agent iterates",
      alert: false,
    });
  });
});

describe("deleteQuestion", () => {
  it("names the artifact and everything that goes with it", () => {
    expect(deleteQuestion("The auth flow")).toBe(
      'Delete "The auth flow"? Every version goes, its open pages say goodbye, and the id stops resolving',
    );
  });
});
