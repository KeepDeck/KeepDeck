import { describe, expect, it } from "vitest";
import { armRefusalLines } from "./armRefusalsView";

describe("armRefusalLines", () => {
  it("names the agent from the catalog, with the folder, the path and the reason", () => {
    const lines = armRefusalLines(
      [
        { agentId: "kimi", cwd: "/repo", path: ".kimi-code/mcp.json", reason: "it is yours" },
        { agentId: "retired", cwd: "/wt", path: ".x", reason: "gone" },
      ],
      [{ id: "kimi", label: "Kimi" }],
    );
    expect(lines.map((line) => line.text)).toEqual([
      "Kimi: /repo/.kimi-code/mcp.json — it is yours",
      // No installed plugin names it: its id, rather than nothing.
      "retired: /wt/.x — gone",
    ]);
    expect(new Set(lines.map((line) => line.key)).size).toBe(2);
  });
});
