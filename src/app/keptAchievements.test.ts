import { describe, expect, it, vi } from "vitest";
import { createKeptAchievements } from "./keptAchievements";

describe("the kept awards", () => {
  it("publishes a copy of the set to every listener, and stops telling one that left", () => {
    const kept = createKeptAchievements();
    expect(kept.getSnapshot().size).toBe(0);
    const listener = vi.fn();
    const leave = kept.subscribe(listener);
    const ids = new Set(["tokens-1000000"]);
    kept.publish(ids);
    expect([...kept.getSnapshot()]).toEqual(["tokens-1000000"]);
    // A copy: the notifier's own set changing later is not a publish.
    ids.add("later");
    expect(kept.getSnapshot().has("later")).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    leave();
    kept.publish(new Set());
    expect(listener).toHaveBeenCalledOnce();
  });
});
