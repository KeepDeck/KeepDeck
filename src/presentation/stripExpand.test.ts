import { describe, expect, it } from "vitest";
import {
  NOTHING_LISTED,
  type ExpandedTeams,
  expandTeams,
  revealScrollTarget,
  scrollAfterCollapse,
  scrollToShow,
  teamsToggleView,
} from "./stripExpand";

describe("which workspaces list their teams", () => {
  const at = (expanded: string[], leaving: string[] = [], kept: string[] = []): ExpandedTeams => ({
    expanded,
    leaving,
    kept,
  });

  it("opens on the active workspace, if it has teams to list", () => {
    expect(expandTeams(NOTHING_LISTED, { kind: "open", activeId: "ws-a", activeHasTeams: true })).toEqual(
      at(["ws-a"]),
    );
    expect(expandTeams(NOTHING_LISTED, { kind: "open", activeId: "ws-a", activeHasTeams: false })).toEqual(
      NOTHING_LISTED,
    );
  });

  it("opens and folds any number of lists, each on its own chevron", () => {
    let state = at(["ws-a"]);
    state = expandTeams(state, { kind: "toggle", wsId: "ws-b" });
    state = expandTeams(state, { kind: "toggle", wsId: "ws-c" });
    expect(state.expanded).toEqual(["ws-a", "ws-b", "ws-c"]);
    state = expandTeams(state, { kind: "toggle", wsId: "ws-b" });
    expect(state).toEqual(at(["ws-a", "ws-c"], ["ws-b"]));
    // Reopened mid-fold: listed again, no longer folding.
    expect(expandTeams(state, { kind: "toggle", wsId: "ws-b" })).toEqual(at(["ws-a", "ws-c", "ws-b"]));
  });

  it("folds every list away with the strip and keeps them for its next open", () => {
    const shut = expandTeams(at(["ws-a", "ws-c"]), { kind: "close" });
    expect(shut).toEqual(at([], ["ws-a", "ws-c"], ["ws-a", "ws-c"]));
    // Reopened from somewhere else: the kept lists, and the active one.
    const reopened = expandTeams(shut, { kind: "open", activeId: "ws-d", activeHasTeams: true });
    expect(reopened).toEqual(at(["ws-a", "ws-c", "ws-d"], [], ["ws-a", "ws-c"]));
  });

  it("forgets a fold once it lands", () => {
    expect(expandTeams(at([], ["ws-a", "ws-b"]), { kind: "settled", wsId: "ws-a" })).toEqual(at([], ["ws-b"]));
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

describe("keeping the active mark in view", () => {
  it("scrolls by the least distance from the edge it is past, and not at all in view", () => {
    expect(scrollToShow(200, 400, { top: -30, bottom: 14 })).toBe(170);
    expect(scrollToShow(0, 400, { top: 420, bottom: 464 })).toBe(64);
    expect(scrollToShow(100, 400, { top: 100, bottom: 144 })).toBeNull();
  });
});
