import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_SPAWN_CONTEXT } from "../domain/spawnPlans";
import {
  paneSpawnSpec,
  peekPaneSpawnSpec,
  resetPaneSpawnSpecs,
  setPaneSpawnSpec,
} from "./spawnSpecs";

const ctx = { ...EMPTY_SPAWN_CONTEXT, spoolDir: "/spool" };

describe("spawnSpecs cache", () => {
  afterEach(resetPaneSpawnSpecs);

  it("is stable across renders — a claude id is minted exactly once", () => {
    const pane = { id: "pane-1", agentType: "claude" as const };
    const first = paneSpawnSpec(pane, ctx, []);
    const second = paneSpawnSpec(pane, ctx, []);
    expect(second).toBe(first);
    expect(first.sessionId).toBeDefined();
  });

  it("a pre-registered revive plan wins over the fresh default", () => {
    const resume = { args: ["--resume", "old"], env: [] as [string, string][] };
    setPaneSpawnSpec("pane-2", resume);
    expect(
      paneSpawnSpec({ id: "pane-2", agentType: "claude" }, ctx, []),
    ).toBe(resume);
    expect(peekPaneSpawnSpec("pane-2")).toBe(resume);
  });

  it("peek never builds", () => {
    expect(peekPaneSpawnSpec("pane-3")).toBeUndefined();
  });
});
