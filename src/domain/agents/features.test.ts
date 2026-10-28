import { describe, expect, it } from "vitest";
import { deliversMcpByCwd } from "./features";

describe("deliversMcpByCwd", () => {
  it("is what the agent's declaration says, and nothing else", () => {
    const mcp = (parameters?: Record<string, string>) => ({
      id: "integration.mcp",
      label: "MCP servers",
      ...(parameters && { parameters }),
    });
    expect(deliversMcpByCwd([mcp({ delivery: "cwd" })])).toBe(true);
    expect(deliversMcpByCwd([mcp()])).toBe(false);
    expect(deliversMcpByCwd([mcp({ delivery: "argv" })])).toBe(false);
    expect(deliversMcpByCwd([])).toBe(false);
    // Declared on another feature, it says nothing about MCP.
    expect(deliversMcpByCwd([{ id: "integration.skills", label: "s", parameters: { delivery: "cwd" } }])).toBe(false);
  });
});
