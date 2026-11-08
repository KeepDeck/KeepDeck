import { describe, expect, it } from "vitest";
import { createUsageSightings } from "./usageSightings";

describe("usage sightings", () => {
  it("answers the first instant a pane's session was seen, however often it is asked", () => {
    let clock = 1_000;
    const sightings = createUsageSightings(() => clock);
    expect(sightings.sight("pane-1", "s-1")).toBe(1_000);
    clock = 2_000;
    expect(sightings.sight("pane-1", "s-1")).toBe(1_000);
  });

  it("sees a new session of the pane, and the same session in another pane, afresh", () => {
    let clock = 1_000;
    const sightings = createUsageSightings(() => clock);
    sightings.sight("pane-1", "s-1");
    clock = 2_000;
    expect(sightings.sight("pane-1", "s-2")).toBe(2_000);
    expect(sightings.sight("pane-2", "s-1")).toBe(2_000);
    // The pane's first session keeps its instant beside the second.
    expect(sightings.sight("pane-1", "s-1")).toBe(1_000);
  });

  it("forgets only the panes that are gone", () => {
    let clock = 1_000;
    const sightings = createUsageSightings(() => clock);
    sightings.sight("pane-1", "s-1");
    sightings.sight("pane-2", "s-2");
    clock = 2_000;
    sightings.retain(new Set(["pane-1"]));
    expect(sightings.sight("pane-1", "s-1")).toBe(1_000);
    expect(sightings.sight("pane-2", "s-2")).toBe(2_000);
  });
});
