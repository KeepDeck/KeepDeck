import { describe, expect, it } from "vitest";
import { generationOf, opencodeGeneration } from "./version";

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

describe("the generation a pane is opened as", () => {
  it("is the version's, and 1.x when there is none — launch, resume and fork alike", () => {
    expect(generationOf("opencode v2.1.4")).toBe(2);
    expect(generationOf("1.19.3")).toBe(1);
    expect(generationOf(undefined)).toBe(1);
    expect(generationOf("opencode")).toBe(1);
  });
});
