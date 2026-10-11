import { describe, expect, it } from "vitest";
import {
  liveSpotlights,
  spotlightOn,
  toggledSpotlight,
  withSpotlight,
  withoutSpotlight,
} from "./spotlights";
import type { Pane } from "./panes";

/** team-1: a-1, a-2; team-2: b-1, b-2; team-3: c-1 alone; x on no team. */
const ws: { panes: Pane[] } = {
  panes: [
    { id: "a-1", team: { teamId: "team-1", role: "lead" } },
    { id: "a-2", team: { teamId: "team-1", role: "impl-1" } },
    { id: "b-1", team: { teamId: "team-2", role: "lead" } },
    { id: "b-2", team: { teamId: "team-2", role: "impl-1" } },
    { id: "c-1", team: { teamId: "team-3", role: "lead" } },
    { id: "x" },
  ],
};

describe("spotlightOn", () => {
  it("answers the spotlight of the pane's own team, whichever member is asked about", () => {
    expect(spotlightOn(ws, ["a-2", "b-1"], "a-1")).toBe("a-2");
    expect(spotlightOn(ws, ["a-2", "b-1"], "b-2")).toBe("b-1");
  });

  it("is null for a team with no spotlight, a team of one, a pane on no team and a pane not there", () => {
    expect(spotlightOn(ws, ["b-1"], "a-1")).toBeNull();
    expect(spotlightOn(ws, ["c-1"], "c-1")).toBeNull();
    expect(spotlightOn(ws, ["x"], "x")).toBeNull();
    expect(spotlightOn(ws, ["a-1"], "gone")).toBeNull();
  });
});

describe("withSpotlight", () => {
  it("replaces the team's spotlight and keeps every other team's", () => {
    expect(withSpotlight(ws, ["a-1", "b-1"], "a-2", "a-2")).toEqual(["b-1", "a-2"]);
  });

  it("drops the team's spotlight when given none, to undefined when it was the last", () => {
    expect(withSpotlight(ws, ["a-1", "b-1"], "a-2")).toEqual(["b-1"]);
    expect(withSpotlight(ws, ["a-1"], "a-2")).toBeUndefined();
  });

  it("gives back the same list for a no-op and for a pane on no grid", () => {
    const focus = ["b-1", "a-1"];
    expect(withSpotlight(ws, focus, "a-1", "a-1")).toBe(focus);
    expect(withSpotlight(ws, focus, "x", "x")).toBe(focus);
    expect(withSpotlight(ws, focus, "gone")).toBe(focus);
  });
});

describe("toggledSpotlight", () => {
  it("takes the team's spotlight, moves it to a teammate, and gives it back", () => {
    const on = toggledSpotlight(ws, ["b-1"], "a-1");
    expect(on).toEqual(["b-1", "a-1"]);
    const moved = toggledSpotlight(ws, on, "a-2");
    expect(moved).toEqual(["b-1", "a-2"]);
    expect(toggledSpotlight(ws, moved, "a-2")).toEqual(["b-1"]);
  });
});

describe("withoutSpotlight", () => {
  it("drops the pane's own spotlight and leaves a teammate's alone", () => {
    expect(withoutSpotlight(["a-1", "b-1"], "a-1")).toEqual(["b-1"]);
    expect(withoutSpotlight(["a-1"], "a-1")).toBeUndefined();
    const focus = ["a-1"];
    expect(withoutSpotlight(focus, "a-2")).toBe(focus);
    expect(withoutSpotlight(undefined, "a-1")).toBeUndefined();
  });
});

describe("liveSpotlights", () => {
  it("keeps what resolves, once per team, and drops a team of one, a pane on no team and a pane not there", () => {
    // Two on team-1 (a hand edit): the one first in deck order stands.
    expect(liveSpotlights(ws, ["a-2", "a-1", "b-1", "c-1", "x", "gone"])).toEqual(["a-1", "b-1"]);
  });

  it("gives back the same list when all of it stands", () => {
    const focus = ["a-1", "b-2"];
    expect(liveSpotlights(ws, focus)).toBe(focus);
    expect(liveSpotlights(ws, undefined)).toBeUndefined();
  });
});
