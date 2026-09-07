import { describe, expect, it } from "vitest";
import { placementRefusalMessage, type PlacementRefusal } from "./placementRefusals";

describe("placementRefusalMessage", () => {
  it("tells the person to wait only when waiting is actually the answer", () => {
    // Their create is out: the directory becomes usable on its own.
    expect(placementRefusalMessage("creating")).toContain("try again in a moment");
    expect(placementRefusalMessage("removing")).toContain("try again in a moment");
    // Ours cannot be made where a team works: waiting changes nothing, and
    // saying otherwise sent people back to a door that would refuse forever.
    // These two were ONE reason once, and the sentence lied on this half.
    expect(placementRefusalMessage("occupied")).not.toContain("try again");
    expect(placementRefusalMessage("abroad")).not.toContain("try again");
    expect(placementRefusalMessage("ending")).not.toContain("try again");
  });

  it("says something for every reason there is", () => {
    const every: PlacementRefusal[] = [
      "abroad",
      "creating",
      "occupied",
      "removing",
      "ending",
      "refused",
    ];
    for (const why of every) {
      expect(placementRefusalMessage(why).length).toBeGreaterThan(10);
    }
  });
});
