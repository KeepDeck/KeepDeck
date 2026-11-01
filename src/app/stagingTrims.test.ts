import { describe, expect, it, vi } from "vitest";
import type { StagingTrim } from "../domain/skills";
import { createStagingTrimStore } from "./stagingTrims";

const trim = (skill: string, over: Partial<StagingTrim> = {}): StagingTrim => ({
  scope: "global",
  skill,
  kind: "link-out",
  path: "lib",
  count: 1,
  ...over,
});
const web = { id: "ws-1", instance: "life-1", name: "web" };
const api = { id: "ws-2", instance: "life-2", name: "api" };

describe("createStagingTrimStore", () => {
  it("replaces what one workspace's stage said, and keeps the others'", () => {
    const store = createStagingTrimStore();
    store.record(web, [trim("review"), trim("deploy")]);
    store.record(api, [trim("review")]);
    // The user fixed `deploy`; web's next stage says only what is still true.
    store.record(web, [trim("review")]);
    expect(store.get().map(({ workspaceId, skill }) => [workspaceId, skill])).toEqual([
      ["ws-2", "review"],
      ["ws-1", "review"],
    ]);
    expect(store.get()[1]).toMatchObject({ workspaceInstance: "life-1", workspaceName: "web" });
  });

  it("lets the stage of a workspace now holding an id replace what a gone one said under it", () => {
    const store = createStagingTrimStore();
    store.record(web, [trim("review")]);
    store.record({ id: "ws-1", instance: "life-9", name: "reborn" }, []);
    expect(store.get()).toEqual([]);
  });

  it("keeps only what live lifetimes said, and drops all of it when the library moves", () => {
    const store = createStagingTrimStore();
    store.record(web, [trim("review")]);
    store.record(api, [trim("review")]);
    store.keep(["life-2"]);
    expect(store.get().map((t) => t.workspaceId)).toEqual(["ws-2"]);
    // An id held by a new lifetime is not the old one's.
    store.keep(["life-7"]);
    expect(store.get()).toEqual([]);
    store.record(web, [trim("review")]);
    store.clear();
    expect(store.get()).toEqual([]);
  });

  it("tells listeners only when what it says changed — by content", () => {
    const store = createStagingTrimStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.record(web, [trim("review")]);
    store.record(web, [trim("review")]);
    expect(listener).toHaveBeenCalledTimes(1);
    store.record(web, [trim("review", { count: 2 })]);
    expect(listener).toHaveBeenCalledTimes(2);
    store.keep(["life-1"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
