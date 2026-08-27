import { describe, expect, it } from "vitest";

import { fitBarGroup, PLUGIN_ACTION_SLOTS } from "./topBar";

describe("fitBarGroup", () => {
  it("draws everything that fits and offers no menu", () => {
    expect(fitBarGroup(["a", "b", "c"], 3)).toEqual({
      shown: ["a", "b", "c"],
      overflow: [],
    });
  });

  it("gives the overflow control a place of its own", () => {
    // The edge the whole rule exists for: spending all three slots on items
    // and hanging the menu off the end turns a ceiling of three into four,
    // and then the next contribution makes it five.
    expect(fitBarGroup(["a", "b", "c", "d"], 3)).toEqual({
      shown: ["a", "b"],
      overflow: ["c", "d"],
    });
  });

  it("keeps the ceiling flat however many arrive", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const fit = fitBarGroup(many, 3);
    expect(fit.shown).toHaveLength(2);
    expect([...fit.shown, ...fit.overflow]).toEqual(many);
  });

  it("folds the lot when there is no room at all", () => {
    // Zero slots must not leave a single item drawn as if it had fitted.
    expect(fitBarGroup(["a"], 0)).toEqual({ shown: [], overflow: ["a"] });
  });

  it("has nothing to fold when there is nothing to draw", () => {
    expect(fitBarGroup([], 3)).toEqual({ shown: [], overflow: [] });
  });

  it("draws nothing when the overflow control would take the only slot", () => {
    // The one place the rule reaches zero drawn items at a non-zero ceiling:
    // one slot, two items, and the control that opens the rest needs it.
    expect(fitBarGroup(["a", "b"], 1)).toEqual({
      shown: [],
      overflow: ["a", "b"],
    });
    // ...but a single item at one slot still fits, with nothing to open.
    expect(fitBarGroup(["a"], 1)).toEqual({ shown: ["a"], overflow: [] });
  });

  it("carries the plugin row's ceiling at its own name", () => {
    const items = Array.from({ length: PLUGIN_ACTION_SLOTS + 1 }, (_, i) => i);
    expect(fitBarGroup(items, PLUGIN_ACTION_SLOTS).shown).toHaveLength(
      PLUGIN_ACTION_SLOTS - 1,
    );
  });
});
