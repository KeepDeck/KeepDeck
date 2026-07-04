import { describe, expect, it } from "vitest";
import {
  addPreset,
  readPaneRun,
  readWorkspaceRun,
  removePreset,
  runEnv,
  setSetup,
  type WorkspaceRun,
} from "./runPresets";

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

describe("readWorkspaceRun", () => {
  it("round-trips a valid config", () => {
    const run: WorkspaceRun = {
      setup: "pnpm i",
      presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }],
    };
    expect(readWorkspaceRun(JSON.parse(JSON.stringify(run)))).toEqual(run);
  });

  it("rejects non-configs as null", () => {
    for (const bad of [undefined, null, 42, "x", [], { setup: "s" }]) {
      expect(readWorkspaceRun(bad)).toBeNull();
    }
  });

  it("drops malformed presets individually, keeps the rest", () => {
    const read = readWorkspaceRun({
      presets: [
        { id: "run-1", name: "ok", command: "cmd" },
        { id: 2, name: "bad id", command: "cmd" },
        { id: "run-3", name: "blank command", command: "  " },
        "not a preset",
      ],
    });
    expect(read?.presets.map((p) => p.id)).toEqual(["run-1"]);
  });

  it("ignores a blank or non-string setup", () => {
    expect(readWorkspaceRun({ presets: [], setup: "  " })?.setup).toBeUndefined();
    expect(readWorkspaceRun({ presets: [], setup: 5 })?.setup).toBeUndefined();
  });
});

describe("readPaneRun", () => {
  it("round-trips, with presetId optional", () => {
    expect(readPaneRun({ command: "pnpm dev" })).toEqual({ command: "pnpm dev" });
    expect(readPaneRun({ command: "pnpm dev", presetId: "run-1" })).toEqual({
      command: "pnpm dev",
      presetId: "run-1",
    });
  });

  it("rejects a missing or blank command", () => {
    for (const bad of [undefined, null, {}, { command: " " }, { presetId: "x" }]) {
      expect(readPaneRun(bad)).toBeNull();
    }
  });
});
