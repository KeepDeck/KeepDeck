import { describe, expect, it } from "vitest";
import { normalizePath, sameDirectory, teamHeldPath } from "./claims";

describe("a team's directory as a path", () => {
  it("is the folder a team runs in, or the one its create is heading for — none without a location", () => {
    expect(teamHeldPath({ location: { kind: "attached", cwd: "/wt/a" } })).toBe("/wt/a");
    expect(
      teamHeldPath({ location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/b", index: 1 } } }),
    ).toBe("/wt/b");
    expect(teamHeldPath({ location: undefined })).toBeUndefined();
  });

  it("names one folder however its edges are spelled, and never empties a root", () => {
    expect(normalizePath(" /wt/a// ")).toBe("/wt/a");
    expect(normalizePath("/")).toBe("/");
    expect(sameDirectory("/repo/", "/repo")).toBe(true);
    expect(sameDirectory("/repo", "/repo2")).toBe(false);
  });
});
