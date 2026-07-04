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
    const first = paneSpawnSpec(pane, ctx, [], "/repo");
    const second = paneSpawnSpec(pane, ctx, [], "/repo");
    expect(second).toBe(first);
    expect(first.sessionId).toBeDefined();
  });

  it("a pre-registered revive plan wins over the fresh default", () => {
    const resume = { args: ["--resume", "old"], env: [] as [string, string][] };
    setPaneSpawnSpec("pane-2", resume);
    expect(
      paneSpawnSpec({ id: "pane-2", agentType: "claude" }, ctx, [], "/repo"),
    ).toBe(resume);
    expect(peekPaneSpawnSpec("pane-2")).toBe(resume);
  });

  it("peek never builds", () => {
    expect(peekPaneSpawnSpec("pane-3")).toBeUndefined();
  });

  it("a run pane gets a shell -c plan with the env contract, not an agent plan", () => {
    const pane = {
      id: "pane-4",
      run: { command: "pnpm dev" },
      branch: "kd/ws/4",
    };
    const spec = paneSpawnSpec(pane, ctx, [], "/wt/4");
    expect(spec.args).toEqual(["-c", "pnpm dev"]);
    expect(spec.env).toEqual([
      ["KEEPDECK_WORKTREE", "/wt/4"],
      ["KEEPDECK_BRANCH", "kd/ws/4"],
    ]);
    // No session identity: run panes stay outside the agent flows.
    expect(spec.sessionId).toBeUndefined();
  });

  it("a pre-registered run plan (launch allocated a port) wins over the fallback", () => {
    const withPort = {
      args: ["-c", "pnpm dev"],
      env: [["KEEPDECK_PORT", "17040"]] as [string, string][],
    };
    setPaneSpawnSpec("pane-5", withPort);
    expect(
      paneSpawnSpec({ id: "pane-5", run: { command: "pnpm dev" } }, ctx, [], "/wt"),
    ).toBe(withPort);
  });
});
