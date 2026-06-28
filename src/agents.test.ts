import { describe, expect, it } from "vitest";
import { AGENT_TYPES, commandForAgent } from "./agents";

describe("commandForAgent", () => {
  it("maps each agent type to its CLI command", () => {
    expect(commandForAgent("claude")).toBe("claude");
    expect(commandForAgent("opencode")).toBe("opencode");
    expect(commandForAgent("codex")).toBe("codex");
  });

  it("lists every type with a label and command", () => {
    expect(AGENT_TYPES.map((a) => a.id)).toEqual(["claude", "opencode", "codex"]);
    for (const a of AGENT_TYPES) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.command.length).toBeGreaterThan(0);
    }
  });
});
