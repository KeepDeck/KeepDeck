import { describe, expect, it } from "vitest";
import { sharedDirectoryAsk, sharedDirectoryRefusal } from "./sharedDirectoryMessage";

const here = { teamId: "team-1", teamName: "api" };
const abroad = { ...here, workspace: "site" };

describe("sharedDirectoryAsk", () => {
  it("names who is there, where, and what saying yes means", () => {
    const { title, message } = sharedDirectoryAsk(here, "/wt/api");
    expect(title).toBe("That directory is already a team's");
    expect(message).toContain("api");
    expect(message).toContain("/wt/api");
    // The promise the teardown actually keeps — `directoriesStillHeld` is
    // what makes this sentence true, so it is pinned with it.
    expect(message).toContain("Neither team's worktree is deleted");
  });

  it("says which workspace, when the holder is in another one", () => {
    expect(sharedDirectoryAsk(abroad, "/wt/api").message).toContain("workspace “site”");
  });
});

describe("sharedDirectoryRefusal", () => {
  it("points an agent at team.add for a team it can actually reach", () => {
    const said = sharedDirectoryRefusal(here);
    expect(said).toContain("team.add puts an agent on it");
    expect(said).toContain("shared: true");
  });

  it("does NOT, for one in another workspace — team.add cannot resolve it there", () => {
    const said = sharedDirectoryRefusal(abroad);
    expect(said).toContain("workspace “site”");
    expect(said).not.toContain("team.add puts an agent on it");
    expect(said).toContain("shared: true");
  });
});
