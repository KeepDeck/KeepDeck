import { describe, expect, it } from "vitest";
import type { McpLibraryRow } from "../../app/mcpLibrary";
import {
  MCP_NAV_COPY,
  buildMcpGroups,
  bundledMcpRows,
  describeMcpRow,
  labelForMcpScope,
} from "./mcpGroups";

const row = (name: string, scope: McpLibraryRow["scope"] = { kind: "global" }): McpLibraryRow => ({
  scope,
  name,
  verdict: { kind: "ok", body: { transport: "stdio", command: "npx", args: ["-y", name], env: {} } },
});

describe("the server nav's groups", () => {
  it("orders Global, the workspace, then Bundled — always present, never authorable", () => {
    const bundled = bundledMcpRows({ command: "/bin/keepdeck", args: ["--mcp-shim", "/s"] });
    const groups = buildMcpGroups(
      [row("github"), row("fs", { kind: "workspace", wsId: "ws-1" })],
      { id: "ws-1", name: "KeepDeck" },
      bundled,
    );
    expect(groups.map((g) => [g.label, g.items.map((r) => r.name), g.canCreate])).toEqual([
      ["Global", ["github"], true],
      ["KeepDeck", ["fs"], true],
      ["Bundled", ["keepdeck"], false],
    ]);
  });

  it("shows only Global and Bundled with no workspace open, and an empty library", () => {
    const groups = buildMcpGroups(null, null, bundledMcpRows(null));
    expect(groups.map((g) => g.label)).toEqual(["Global", "Bundled"]);
    expect(groups[0]!.items).toEqual([]);
  });

  it("presents the deck's server with the invocation the backend hands out", () => {
    const [keepdeck] = bundledMcpRows({ command: "/bin/keepdeck", args: ["--mcp-shim", "/s"] });
    expect(describeMcpRow(keepdeck!)).toBe("/bin/keepdeck --mcp-shim /s");
    // Until the socket is confirmed there is no invocation to show.
    expect(describeMcpRow(bundledMcpRows(null)[0]!)).toBe("starting up…");
  });

  it("describes a row by what it runs or reaches, or why it cannot be read", () => {
    expect(describeMcpRow(row("github"))).toBe("npx -y github");
    expect(
      describeMcpRow({
        scope: { kind: "global" },
        name: "r",
        verdict: { kind: "ok", body: { transport: "http", url: "https://x/", headers: {} } },
      }),
    ).toBe("https://x/");
    expect(
      describeMcpRow({ scope: { kind: "global" }, name: "b", verdict: { kind: "malformed", reason: "no" } }),
    ).toBe("Cannot be read — no");
  });

  it("labels a scope from the groups, the bundled tier included", () => {
    const groups = buildMcpGroups([], { id: "ws-1", name: "KeepDeck" }, bundledMcpRows(null));
    expect(labelForMcpScope(groups, { kind: "workspace", wsId: "ws-1" })).toBe("KeepDeck");
    expect(labelForMcpScope(groups, { kind: "bundled" })).toBe("Bundled");
    expect(labelForMcpScope(groups, { kind: "workspace", wsId: "ws-9" })).toBe("Workspace");
    expect(MCP_NAV_COPY.scopeKey({ kind: "bundled" })).toBe("bundled");
  });
});
