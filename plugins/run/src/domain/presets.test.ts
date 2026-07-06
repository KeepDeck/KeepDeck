import { describe, expect, it } from "vitest";
import {
  addPreset,
  removePreset,
  runEnv,
  updatePreset,
  type RunPreset,
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
    const one = addPreset([], "  Dev  ", " pnpm dev ");
    expect(one).toEqual([{ id: "run-1", name: "Dev", command: "pnpm dev" }]);
    const two = addPreset(one, "Worker", "pnpm worker");
    expect(two.map((p) => p.id)).toEqual(["run-1", "run-2"]);
  });

  it("keeps minting past removals — ids are never reused", () => {
    let presets = addPreset([], "a", "cmd-a");
    presets = addPreset(presets, "b", "cmd-b");
    presets = removePreset(presets, "run-1");
    presets = addPreset(presets, "c", "cmd-c");
    expect(presets.map((p) => p.id)).toEqual(["run-2", "run-3"]);
  });

  it("falls back to the (truncated) command when the name is blank", () => {
    const presets = addPreset([], "  ", "x".repeat(64));
    expect(presets[0].name).toHaveLength(32);
    expect(presets[0].name.endsWith("…")).toBe(true);
  });

  it("removePreset of an unknown id returns the SAME array", () => {
    const presets = addPreset([], "a", "cmd");
    expect(removePreset(presets, "run-9")).toBe(presets);
  });
});

describe("updatePreset", () => {
  const seeded = (): RunPreset[] => [
    { id: "run-1", name: "Dev", command: "pnpm dev" },
    { id: "run-2", name: "Worker", command: "pnpm worker" },
  ];

  it("rewrites name and command in place, keeping id and order", () => {
    const presets = updatePreset(seeded(), "run-1", " Debug ", " pnpm tauri dev ");
    expect(presets).toEqual([
      { id: "run-1", name: "Debug", command: "pnpm tauri dev" },
      { id: "run-2", name: "Worker", command: "pnpm worker" },
    ]);
  });

  it("a blank name falls back to the (truncated) command", () => {
    const presets = updatePreset(seeded(), "run-2", "  ", "make dev");
    expect(presets[1].name).toBe("make dev");
  });

  it("is a no-op (same ref) for unknown ids and blank commands", () => {
    const presets = seeded();
    expect(updatePreset(presets, "run-9", "x", "cmd")).toBe(presets);
    expect(updatePreset(presets, "run-1", "x", "   ")).toBe(presets);
  });
});
