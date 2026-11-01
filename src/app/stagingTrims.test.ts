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
const web = { id: "ws-1", name: "web" };
const api = { id: "ws-2", name: "api" };

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
    expect(store.get()[1]).toMatchObject({ workspaceName: "web" });
  });

  it("keeps only what was said about live workspaces, and drops all of it when the library moves", () => {
    const store = createStagingTrimStore();
    store.record(web, [trim("review")]);
    store.record(api, [trim("review")]);
    store.keep(["ws-2"]);
    expect(store.get().map((t) => t.workspaceId)).toEqual(["ws-2"]);
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
    store.keep(["ws-1"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
