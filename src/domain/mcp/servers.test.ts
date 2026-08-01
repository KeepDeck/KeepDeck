import { describe, expect, it } from "vitest";
import {
  acceptMcpServers,
  isValidMcpServerName,
  type McpServerDef,
} from "./servers";

const def = (name: string): McpServerDef => ({
  name,
  transport: "stdio",
  command: "/bin/keepdeck",
  args: ["--mcp-shim", "/sock"],
});

describe("isValidMcpServerName", () => {
  it("accepts what a tool name can carry, and nothing else", () => {
    expect(isValidMcpServerName("keepdeck")).toBe(true);
    expect(isValidMcpServerName("my-server_2")).toBe(true);
    // A dot is the one that matters: tool names flatten namespaces with
    // underscores precisely because external grammars refuse dots.
    expect(isValidMcpServerName("my.server")).toBe(false);
    expect(isValidMcpServerName("")).toBe(false);
    expect(isValidMcpServerName("has space")).toBe(false);
    expect(isValidMcpServerName("x".repeat(65))).toBe(false);
  });
});

describe("acceptMcpServers", () => {
  it("keeps the given order — a config's entries are not a set", () => {
    const { accepted, rejected } = acceptMcpServers([
      def("keepdeck"),
      def("mnemo"),
    ]);
    expect(accepted.map((d) => d.name)).toEqual(["keepdeck", "mnemo"]);
    expect(rejected).toEqual([]);
  });

  it("drops a later duplicate, so the FIRST claim on a name survives", () => {
    // Every CLI keys its servers by name: two entries under one key means one
    // silently overwrites the other, and which one differs per CLI. The
    // built-in server is contributed first, so a bank entry cannot shadow it.
    const first = { ...def("keepdeck"), command: "/built-in" };
    const second = { ...def("keepdeck"), command: "/from-the-bank" };
    const { accepted, rejected } = acceptMcpServers([first, second]);
    expect(accepted).toEqual([first]);
    expect(rejected).toEqual([{ name: "keepdeck", reason: "duplicate-name" }]);
  });

  it("drops an unusable name and keeps serving the rest", () => {
    const { accepted, rejected } = acceptMcpServers([
      def("keep.deck"),
      def("mnemo"),
    ]);
    expect(accepted.map((d) => d.name)).toEqual(["mnemo"]);
    expect(rejected).toEqual([{ name: "keep.deck", reason: "invalid-name" }]);
  });

  it("reports EVERY offender, not just the first", () => {
    // The bank will show these to the user, one line per entry it could not
    // inject: stopping at the first would leave the rest looking accepted.
    const { accepted, rejected } = acceptMcpServers([
      def("keepdeck"),
      def("keepdeck"),
      def("keepdeck"),
    ]);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(2);
  });

  it("has nothing to say about an empty set", () => {
    expect(acceptMcpServers([])).toEqual({ accepted: [], rejected: [] });
  });
});
