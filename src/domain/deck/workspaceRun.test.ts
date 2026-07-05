import { describe, expect, it } from "vitest";
import { readWorkspaceRun, type WorkspaceRun } from "./workspaceRun";

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
