import { describe, expect, it, vi } from "vitest";
import { createSkillRefusalStore } from "./skillRefusals";

describe("the refusal store", () => {
  it("republishes an EMPTY list, which is how a fix clears the banner", () => {
    // THE PIN the whole memo-split exists for: a refusal is a standing
    // condition, so the arming pass that follows the user's fix reports
    // nothing and the surface must go quiet on its own.
    const store = createSkillRefusalStore();
    const seen = vi.fn();
    store.subscribe(seen);

    store.publish([{ root: "/repo", reason: "your file is there" }]);
    expect(store.get()).toHaveLength(1);

    store.publish([]);
    expect(store.get()).toEqual([]);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("says nothing when the same refusals come round again", () => {
    // Every spawn arms; an unchanged condition must not repaint.
    const store = createSkillRefusalStore();
    const seen = vi.fn();
    store.subscribe(seen);
    const same = [{ root: "/repo", reason: "your file is there" }];

    store.publish(same);
    store.publish([...same]);

    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("notices a reason that changed under the same root", () => {
    // They deleted the file and made the directory their own: same length,
    // different sentence, and the old one would now be a lie.
    const store = createSkillRefusalStore();
    const seen = vi.fn();
    store.subscribe(seen);

    store.publish([{ root: "/repo", reason: "a file named .agents" }]);
    store.publish([{ root: "/repo", reason: "your own directory" }]);

    expect(seen).toHaveBeenCalledTimes(2);
    expect(store.get()[0].reason).toBe("your own directory");
  });
});
