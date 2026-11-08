import { describe, expect, it } from "vitest";
import { streakView } from "./streakView";

describe("streakView", () => {
  it("shows no chip without a streak", () => {
    expect(streakView(0)).toBeNull();
  });

  it("says the streak in days, one day singular", () => {
    expect(streakView(1)).toMatchObject({ label: "1-day streak", count: "1", unit: "day" });
    expect(streakView(4)).toMatchObject({ label: "4-day streak", count: "4", unit: "days" });
  });

  it("gives a short streak no mark and a three-day one a coal", () => {
    expect(streakView(2)?.mark).toEqual({ kind: "none" });
    expect(streakView(3)?.mark).toEqual({ kind: "coal" });
  });

  it("grows the flame with the streak, and only the inferno sparks", () => {
    expect(streakView(7)?.mark).toEqual({ kind: "fire", size: 13, inferno: false, sparks: [] });
    expect(streakView(30)?.mark).toEqual({ kind: "fire", size: 16, inferno: false, sparks: [] });
    const inferno = streakView(100)?.mark;
    expect(inferno).toMatchObject({ kind: "fire", size: 18, inferno: true });
    expect(inferno?.kind === "fire" ? inferno.sparks : []).toHaveLength(5);
  });
});
