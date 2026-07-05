import { describe, expect, it, vi } from "vitest";
import { createContributionRegistry } from "./contributions";

describe("createContributionRegistry", () => {
  it("lists entries in insertion order, tagged with the owning plugin", () => {
    const reg = createContributionRegistry<string>();
    reg.add("a", "first");
    reg.add("b", "second");
    reg.add("a", "third");
    expect(reg.list()).toEqual([
      { pluginId: "a", entry: "first" },
      { pluginId: "b", entry: "second" },
      { pluginId: "a", entry: "third" },
    ]);
  });

  it("keeps a stable snapshot reference between changes and a new one after each", () => {
    const reg = createContributionRegistry<string>();
    const empty = reg.list();
    expect(reg.list()).toBe(empty); // no change → same reference

    const dispose = reg.add("a", "x").dispose;
    const afterAdd = reg.list();
    expect(afterAdd).not.toBe(empty);
    expect(reg.list()).toBe(afterAdd); // stable until the next change

    dispose();
    const afterDispose = reg.list();
    expect(afterDispose).not.toBe(afterAdd);
    expect(reg.list()).toBe(afterDispose);
  });

  it("notifies subscribers on add and on dispose, and stops after unsubscribe", () => {
    const reg = createContributionRegistry<string>();
    const listener = vi.fn();
    const unsubscribe = reg.subscribe(listener);

    const handle = reg.add("a", "x");
    expect(listener).toHaveBeenCalledTimes(1);
    handle.dispose();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    reg.add("a", "y");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("disposes idempotently — a second dispose neither removes nor notifies", () => {
    const reg = createContributionRegistry<string>();
    const a = reg.add("a", "keep");
    const b = reg.add("a", "drop");
    const listener = vi.fn();
    reg.subscribe(listener);

    b.dispose();
    b.dispose();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reg.list()).toEqual([{ pluginId: "a", entry: "keep" }]);
    a.dispose(); // sibling still disposes cleanly
    expect(reg.list()).toEqual([]);
  });

  it("removeAllFor drops one plugin's entries and leaves the rest", () => {
    const reg = createContributionRegistry<string>();
    reg.add("a", "a1");
    reg.add("b", "b1");
    reg.add("a", "a2");
    reg.removeAllFor("a");
    expect(reg.list()).toEqual([{ pluginId: "b", entry: "b1" }]);
  });

  it("a disposable already swept by removeAllFor is a silent no-op", () => {
    const reg = createContributionRegistry<string>();
    const handle = reg.add("a", "x");
    reg.removeAllFor("a");
    const swept = reg.list();
    const listener = vi.fn();
    reg.subscribe(listener);

    handle.dispose(); // record is already gone
    expect(listener).not.toHaveBeenCalled();
    expect(reg.list()).toBe(swept); // snapshot reference untouched
  });
});
