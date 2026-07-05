import { describe, expect, it } from "vitest";
import type { WorkspaceRun } from "../deck";
import {
  addPreset,
  removePreset,
  runEnv,
  setSetup,
  updatePreset,
} from "./presets";

describe("runEnv", () => {
  it("always carries the worktree, adds branch and port when known", () => {
    expect(runEnv({ worktree: "/wt" })).toEqual([["KEEPDECK_WORKTREE", "/wt"]]);
    expect(runEnv({ worktree: "/wt", branch: "kd/x", port: 17040 })).toEqual([
      ["KEEPDECK_WORKTREE", "/wt"],
      ["KEEPDECK_BRANCH", "kd/x"],
      ["KEEPDECK_PORT", "17040"],
    ]);
  });

  it("omits the port instead of inventing a default", () => {
    const keys = runEnv({ worktree: "/wt", branch: "b" }).map(([k]) => k);
    expect(keys).not.toContain("KEEPDECK_PORT");
  });
});

describe("addPreset / removePreset", () => {
  it("mints sequential run-N ids and trims fields", () => {
    const one = addPreset(undefined, "  Dev  ", " pnpm dev ");
    expect(one.presets).toEqual([{ id: "run-1", name: "Dev", command: "pnpm dev" }]);
    const two = addPreset(one, "Worker", "pnpm worker");
    expect(two.presets.map((p) => p.id)).toEqual(["run-1", "run-2"]);
  });

  it("keeps minting past removals — ids are never reused", () => {
    let run = addPreset(undefined, "a", "cmd-a");
    run = addPreset(run, "b", "cmd-b");
    run = removePreset(run, "run-1");
    run = addPreset(run, "c", "cmd-c");
    expect(run.presets.map((p) => p.id)).toEqual(["run-2", "run-3"]);
  });

  it("falls back to the (truncated) command when the name is blank", () => {
    const run = addPreset(undefined, "  ", "x".repeat(64));
    expect(run.presets[0].name).toHaveLength(32);
    expect(run.presets[0].name.endsWith("…")).toBe(true);
  });

  it("removePreset of an unknown id returns the SAME object", () => {
    const run = addPreset(undefined, "a", "cmd");
    expect(removePreset(run, "run-9")).toBe(run);
  });
});

describe("setSetup", () => {
  it("sets, replaces and clears (blank) the setup command", () => {
    const withSetup = setSetup(undefined, " pnpm i ");
    expect(withSetup).toEqual({ presets: [], setup: "pnpm i" });
    const replaced = setSetup(withSetup, "make deps");
    expect(replaced.setup).toBe("make deps");
    expect(setSetup(replaced, "   ")).toEqual({ presets: [] });
  });

  it("preserves existing presets", () => {
    const run = setSetup(addPreset(undefined, "a", "cmd"), "pnpm i");
    expect(run.presets).toHaveLength(1);
  });
});


describe("updatePreset", () => {
  const seeded = (): WorkspaceRun => ({
    presets: [
      { id: "run-1", name: "Dev", command: "pnpm dev" },
      { id: "run-2", name: "Worker", command: "pnpm worker" },
    ],
  });

  it("rewrites name and command in place, keeping id and order", () => {
    const run = updatePreset(seeded(), "run-1", " Debug ", " pnpm tauri dev ");
    expect(run.presets).toEqual([
      { id: "run-1", name: "Debug", command: "pnpm tauri dev" },
      { id: "run-2", name: "Worker", command: "pnpm worker" },
    ]);
  });

  it("a blank name falls back to the (truncated) command", () => {
    const run = updatePreset(seeded(), "run-2", "  ", "make dev");
    expect(run.presets[1].name).toBe("make dev");
  });

  it("is a no-op (same ref) for unknown ids and blank commands", () => {
    const run = seeded();
    expect(updatePreset(run, "run-9", "x", "cmd")).toBe(run);
    expect(updatePreset(run, "run-1", "x", "   ")).toBe(run);
  });
});
