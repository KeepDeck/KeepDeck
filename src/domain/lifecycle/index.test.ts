import { describe, expect, it } from "vitest";
import { isForgotten } from ".";

const forgotten = { workspaces: ["ws-gone"], teams: ["team-gone"], panes: ["pane-9"] };

describe("a write's source against what the lifecycle forgot", () => {
  it("is forgotten by any one of its workspace, team or pane", () => {
    expect(isForgotten(forgotten, { workspace: "ws-gone" })).toBe(true);
    expect(isForgotten(forgotten, { workspace: "ws-a", team: "team-gone" })).toBe(true);
    expect(isForgotten(forgotten, { workspace: "ws-a", team: "team-1", pane: "pane-9" })).toBe(true);
  });

  it("is not by what it does not have, nor by a neighbour's", () => {
    expect(isForgotten(forgotten, { workspace: "ws-a", team: null, pane: null })).toBe(false);
    expect(isForgotten(forgotten, { workspace: "ws-a", team: "team-1", pane: "pane-1" })).toBe(false);
    expect(isForgotten({ workspaces: [], teams: [], panes: [] }, { workspace: "ws-gone" })).toBe(false);
  });
});
