import { describe, expect, it } from "vitest";
import {
  expandTeams,
  revealScrollTarget,
  scrollAfterCollapse,
  scrollAfterInstantCollapse,
  teamsToggleView,
} from "./stripExpand";

describe("which workspace lists its teams", () => {
  it("opens on the active workspace, if it has teams to list", () => {
    expect(expandTeams(null, { kind: "open", activeId: "ws-a", activeHasTeams: true })).toBe("ws-a");
    expect(expandTeams(null, { kind: "open", activeId: "ws-a", activeHasTeams: false })).toBeNull();
  });

  it("keeps ONE list open: a chevron moves it, the same chevron closes it", () => {
    expect(expandTeams("ws-a", { kind: "toggle", wsId: "ws-b" })).toBe("ws-b");
    expect(expandTeams("ws-b", { kind: "toggle", wsId: "ws-b" })).toBeNull();
    expect(expandTeams(null, { kind: "toggle", wsId: "ws-c" })).toBe("ws-c");
  });

  it("lists nothing once the strip shuts", () => {
    expect(expandTeams("ws-a", { kind: "close" })).toBeNull();
  });
});

describe("the scroll an opening list needs", () => {
  it("does not move a list that already fits", () => {
    expect(revealScrollTarget(0, 400, { top: 100, bottom: 144 }, 120)).toBeNull();
  });

  it("scrolls only as far as the list overflows", () => {
    // Row bottom 300 + list 160 = 460 against a 400 viewport: 60 over.
    expect(revealScrollTarget(50, 400, { top: 256, bottom: 300 }, 160)).toBe(110);
  });

  it("never scrolls the workspace's own row off the top for a tall list", () => {
    // 392px of teams under a row at 200: the overflow is 236, but the row
    // may only rise to the top — 200.
    expect(revealScrollTarget(0, 400, { top: 200, bottom: 244 }, 392)).toBe(200);
  });
});

describe("keeping the row under the pointer still", () => {
  it("moves the scroll up by a list collapsed above it, not by one below", () => {
    expect(scrollAfterInstantCollapse(300, 120, true)).toBe(180);
    expect(scrollAfterInstantCollapse(300, 120, false)).toBe(300);
    expect(scrollAfterInstantCollapse(60, 120, true)).toBe(0);
  });

  it("lands a collapse's scroll where the shrunk list will clamp it", () => {
    // 1000 of content, 400 shown, scrolled to 550; 200 collapses → max 400.
    expect(scrollAfterCollapse(550, 1000, 400, 200)).toBe(400);
    expect(scrollAfterCollapse(300, 1000, 400, 200)).toBeNull();
    expect(scrollAfterCollapse(100, 450, 400, 200)).toBe(0);
  });
});

describe("a workspace's teams toggle", () => {
  const teams = [{ id: "t1", name: "api", dot: "none" as const, open: false, label: "" }];

  it("is not there for a workspace without teams", () => {
    expect(teamsToggleView({ name: "KeepDeck", teams: [] }, false)).toBeNull();
  });

  it("counts a closed list and names what it will do", () => {
    expect(teamsToggleView({ name: "KeepDeck", teams }, false)).toEqual({
      label: "Show teams of KeepDeck",
      count: "1",
    });
    expect(teamsToggleView({ name: "KeepDeck", teams }, true)).toEqual({
      label: "Hide teams of KeepDeck",
      count: null,
    });
  });
});
