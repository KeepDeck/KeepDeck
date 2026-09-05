import { describe, expect, it } from "vitest";
import type { BundledMcpDescription } from "../../app/mcp";
import type { McpLibraryRow } from "../../app/mcpLibrary";
import { BUNDLED_PENDING, bundledMcpRows } from "./bundledTier";
import {
  MCP_NAV_COPY,
  buildMcpGroups,
  describeMcpRow,
  labelForMcpScope,
} from "./mcpGroups";

/** The tier as the service describes it: up, or not yet. */
const tier = (up: boolean): BundledMcpDescription[] => [
  {
    name: "keepdeck",
    body: up ? { transport: "stdio", command: "/bin/keepdeck", args: ["--mcp-shim", "/s"], env: {} } : null,
  },
];

const row = (name: string, scope: McpLibraryRow["scope"] = { kind: "global" }): McpLibraryRow => ({
  scope,
  name,
  verdict: { kind: "ok", body: { transport: "stdio", command: "npx", args: ["-y", name], env: {} } },
});

describe("the server nav's groups", () => {
  it("orders Global, the workspace, then Bundled — always present, never authorable", () => {
    const groups = buildMcpGroups(
      [row("github"), row("fs", { kind: "workspace", wsId: "ws-1" })],
      { id: "ws-1", name: "KeepDeck" },
      bundledMcpRows(tier(true)),
    );
    expect(groups.map((g) => [g.label, g.items.map((r) => r.name), g.createScope])).toEqual([
      ["Global", ["github"], { kind: "global" }],
      ["KeepDeck", ["fs"], { kind: "workspace", wsId: "ws-1" }],
      ["Bundled", ["keepdeck"], null],
    ]);
  });

  it("shows only Global and Bundled with no workspace open, and an empty library", () => {
    const groups = buildMcpGroups(null, null, bundledMcpRows(tier(false)));
    expect(groups.map((g) => g.label)).toEqual(["Global", "Bundled"]);
    expect(groups[0]!.items).toEqual([]);
  });

  it("presents the deck's server with the invocation the backend hands out", () => {
    const [keepdeck] = bundledMcpRows(tier(true));
    expect(describeMcpRow(keepdeck!)).toBe("/bin/keepdeck --mcp-shim /s");
    // Until the socket is confirmed there is no invocation to show — and the
    // row says so in the same words the panel does.
    const [pending] = bundledMcpRows(tier(false));
    expect(pending!.verdict).toEqual({ kind: "pending" });
    expect(describeMcpRow(pending!)).toBe(BUNDLED_PENDING);
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
    const groups = buildMcpGroups([], { id: "ws-1", name: "KeepDeck" }, bundledMcpRows(tier(false)));
    expect(labelForMcpScope(groups, { kind: "workspace", wsId: "ws-1" })).toBe("KeepDeck");
    expect(labelForMcpScope(groups, { kind: "bundled" })).toBe("Bundled");
    expect(labelForMcpScope(groups, { kind: "workspace", wsId: "ws-9" })).toBe("Workspace");
    expect(MCP_NAV_COPY.scopeKey({ kind: "bundled" })).toBe("bundled");
  });
});
