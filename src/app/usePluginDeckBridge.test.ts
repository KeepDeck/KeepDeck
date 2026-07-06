import { describe, expect, it } from "vitest";
import { closedWorkspaceIds } from "./usePluginDeckBridge";

describe("closedWorkspaceIds", () => {
  it("names exactly the ids that disappeared", () => {
    expect(closedWorkspaceIds(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
  });

  it("is empty on growth, reorder, and the first render", () => {
    expect(closedWorkspaceIds([], ["a"])).toEqual([]);
    expect(closedWorkspaceIds(["a", "b"], ["b", "a", "c"])).toEqual([]);
  });

  it("reports several removals at once (multi-close on hydrate)", () => {
    expect(closedWorkspaceIds(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });
});
