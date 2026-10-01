import { describe, expect, it } from "vitest";
import {
  NOTHING_LISTED,
  listChanges,
  planListMotions,
  type ExpandedTeams,
  expandTeams,
  revealScrollTarget,
  scrollAfterCollapse,
  scrollToShow,
  stripGroupView,
  teamsToggleView,
} from "./stripExpand";

describe("which workspaces list their teams", () => {
  const at = (
    expanded: string[],
    leaving: string[] = [],
    kept: string[] = [],
    held: string | null = null,
  ): ExpandedTeams => ({ expanded, leaving, kept, held });

  it("opens on the active workspace, if it has teams to list", () => {
    expect(expandTeams(NOTHING_LISTED, { kind: "open", activeId: "ws-a", listable: ["ws-a"] })).toEqual(
      at(["ws-a"]),
    );
    expect(expandTeams(NOTHING_LISTED, { kind: "open", activeId: "ws-a", listable: [] })).toEqual(
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
    const reopened = expandTeams(shut, { kind: "open", activeId: "ws-d", listable: ["ws-a", "ws-c", "ws-d"] });
    expect(reopened).toEqual(at(["ws-a", "ws-c", "ws-d"], [], ["ws-a", "ws-c"]));
    // A kept workspace emptied of teams (or gone) does not come back.
    const emptied = expandTeams(shut, { kind: "open", activeId: "ws-d", listable: ["ws-c", "ws-d"] });
    expect(emptied).toEqual(at(["ws-c", "ws-d"], [], ["ws-c"]));
  });

  it("folds a dragged workspace's own list away, and reopens it on release", () => {
    // Folding, as a chevron folds it: the drag carries a mark, not a hole.
    const held = expandTeams(at(["ws-a", "ws-b"]), { kind: "hold", wsId: "ws-b" });
    expect(held).toEqual(at(["ws-a"], ["ws-b"], [], "ws-b"));
    expect(expandTeams(held, { kind: "release" })).toEqual(at(["ws-a", "ws-b"]));
    // A workspace with no list open holds nothing.
    expect(expandTeams(at(["ws-a"]), { kind: "hold", wsId: "ws-c" })).toEqual(at(["ws-a"]));
    // Shut mid-drag: the held list is kept for the next open.
    expect(expandTeams(held, { kind: "close" }).kept).toEqual(["ws-a", "ws-b"]);
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

  it("counts what lists opening above it on the same frames will add", () => {
    // Row at 200–244, its list 100, in a 400 view: fits on its own...
    expect(revealScrollTarget(0, 400, { top: 200, bottom: 244 }, 100)).toBeNull();
    // ...but two kept lists above it grow 120 meanwhile: it lands at
    // 320–364, and its list runs 64 past the bottom.
    expect(revealScrollTarget(0, 400, { top: 200, bottom: 244 }, 100, 120)).toBe(64);
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
    expect(teamsToggleView({ name: "KeepDeck", teams: [] }, false, true)).toBeNull();
  });

  it("counts a closed list and names what it will do", () => {
    expect(teamsToggleView({ name: "KeepDeck", teams }, false, true)).toEqual({
      label: "Show teams of KeepDeck",
      count: "1",
      expanded: false,
      reachable: true,
    });
    expect(teamsToggleView({ name: "KeepDeck", teams }, true, true)).toMatchObject({
      label: "Hide teams of KeepDeck",
      count: null,
    });
  });

  it("is out of reach while the strip is shut — out of sight past its edge", () => {
    expect(teamsToggleView({ name: "KeepDeck", teams }, false, false)!.reachable).toBe(false);
  });
});

describe("a workspace's group in the column", () => {
  const teams = [{ id: "t1", name: "api", dot: "none" as const, open: false, label: "" }];
  const strip = { open: true, draggedId: null };

  it("is the empty slot only for the workspace a drag holds", () => {
    expect(stripGroupView({ id: "a", name: "A", teams }, { expanded: true, drawn: true }, { open: true, draggedId: "a" }).placeholder).toBe(true);
    expect(stripGroupView({ id: "b", name: "B", teams }, { expanded: true, drawn: true }, { open: true, draggedId: "a" }).placeholder).toBe(false);
  });

  it("draws no list for a workspace left with no teams, even one still listed", () => {
    // Its last team disbanded while the list was open: nothing to draw,
    // and no chevron to close an empty list with.
    const emptied = stripGroupView({ id: "a", name: "A", teams: [] }, { expanded: true, drawn: true }, strip);
    expect(emptied.listDrawn).toBe(false);
    expect(emptied.toggle).toBeNull();
    expect(stripGroupView({ id: "a", name: "A", teams }, { expanded: true, drawn: true }, strip).listDrawn).toBe(true);
  });
});

describe("keeping the active mark in view", () => {
  it("scrolls by the least distance from the edge it is past, and not at all in view", () => {
    expect(scrollToShow(200, 400, { top: -30, bottom: 14 })).toBe(170);
    expect(scrollToShow(0, 400, { top: 420, bottom: 464 })).toBe(64);
    expect(scrollToShow(100, 400, { top: 100, bottom: 144 })).toBeNull();
  });
});

describe("which lists move this commit", () => {
  it("opens the newly listed, folds the newly folding, leaves the rest", () => {
    const was = { expanded: ["a"], leaving: [], kept: [], held: null };
    const now = { expanded: ["a", "b"], leaving: ["c"], kept: [], held: null };
    expect(listChanges(was, now)).toEqual({ opened: ["b"], folding: ["c"] });
  });
});

describe("the commit's list motions", () => {
  const column = { scrollTop: 0, viewportHeight: 400, contentHeight: 800 };
  const opening = (id: string, top: number, full: number, reached = 0) => ({
    id,
    reached,
    full,
    row: { top, bottom: top + 44 },
  });

  it("lets the one list asked for carry the scroll, from where it was caught", () => {
    const [plan] = planListMotions([opening("b", 330, 100, 20)], [], "a", ["a", "b"], column);
    expect(plan).toEqual({ id: "b", from: 20, to: 100, scrollTo: 54 });
  });

  it("lets only the active list carry the scroll when several open", () => {
    const plans = planListMotions(
      [opening("a", 0, 120), opening("c", 200, 100)],
      [],
      "c",
      ["a", "b", "c"],
      column,
    );
    // c lands 120 lower (a grows above it): 320–364, its 100 runs 64 over.
    expect(plans.map((p) => [p.id, p.scrollTo])).toEqual([
      ["a", null],
      ["c", 64],
    ]);
  });

  it("lets no opener scroll when none is asked for and none is active", () => {
    const plans = planListMotions([opening("a", 0, 50), opening("b", 300, 200)], [], "z", ["a", "b"], column);
    expect(plans.every((p) => p.scrollTo === null)).toBe(true);
  });

  it("gives the first fold the clamp the folds' combined loss causes", () => {
    const scrolled = { scrollTop: 450, viewportHeight: 400, contentHeight: 1000 };
    const plans = planListMotions([], [{ id: "a", height: 120 }, { id: "b", height: 80 }], null, ["a", "b"], scrolled);
    expect(plans.map((p) => [p.id, p.from, p.to, p.scrollTo])).toEqual([
      ["a", 120, 0, 400],
      ["b", 80, 0, null],
    ]);
  });

  it("keeps a fold off the scroll an opener is already carrying", () => {
    const scrolled = { scrollTop: 450, viewportHeight: 400, contentHeight: 1000 };
    const plans = planListMotions([opening("c", 380, 100)], [{ id: "a", height: 300 }], null, ["a", "c"], scrolled);
    expect(plans.find((p) => p.id === "a")!.scrollTo).toBeNull();
  });
});
