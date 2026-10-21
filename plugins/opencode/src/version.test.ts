import { describe, expect, it } from "vitest";
import { opencodeGeneration, standaloneArgs } from "./version";

describe("which opencode a pane runs", () => {
  it.each([
    // Exactly what each generation prints (task-376, measured).
    ["1.19.3", 1],
    ["opencode v2.1.2", 2],
    ["opencode v3.0.0", 2],
    ["0.15.0", 1],
  ] as const)("reads %s as generation %s", (version, generation) => {
    expect(opencodeGeneration(version)).toBe(generation);
  });

  it("knows nothing from no answer, or from one that is not a version", () => {
    expect(opencodeGeneration(undefined)).toBeNull();
    expect(opencodeGeneration("opencode")).toBeNull();
  });
});

describe("a pane's own server", () => {
  it("is asked for on 2.x alone — 1.x exits on the flag", () => {
    expect(standaloneArgs("opencode v2.1.2")).toEqual(["--standalone"]);
    expect(standaloneArgs("1.19.3")).toEqual([]);
  });

  it("is not asked for when the release is unknown", () => {
    expect(standaloneArgs(undefined)).toEqual([]);
  });
});
