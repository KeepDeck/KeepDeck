import { describe, expect, it } from "vitest";
import { teamOnScreen } from "./teamOnScreen";

describe("teamOnScreen", () => {
  it("follows the focused task's team, then the choice, then the first", () => {
    const teams = ["team-1", "team-2"];
    expect(teamOnScreen(teams, null, null)).toBe("team-1");
    expect(teamOnScreen(teams, "team-2", null)).toBe("team-2");
    expect(teamOnScreen(teams, "team-1", "team-2")).toBe("team-2");
    expect(teamOnScreen(teams, "team-9", "team-9")).toBe("team-1");
    expect(teamOnScreen([], "team-1", null)).toBeNull();
  });
});
