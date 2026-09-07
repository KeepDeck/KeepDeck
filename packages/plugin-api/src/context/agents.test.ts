import { describe, expect, it } from "vitest";
import { API_VERSION } from "../manifest/version.ts";
import {
  MCP_HTTP_API,
  mapMcpServers,
  mcpHttpHeaders,
  type McpHttpServerSpec,
  type McpServerSpec,
} from "./agents.ts";

describe("MCP_HTTP_API", () => {
  it("names a revision the current contract includes, and never moves past it", () => {
    // A fact of history: the revision the arm appeared in. Bumping it with
    // API_VERSION would withhold remote servers from every plugin built
    // against a revision that already had them.
    expect(MCP_HTTP_API).toBe(45);
    expect(MCP_HTTP_API).toBeLessThanOrEqual(API_VERSION);
  });
});

const local: McpServerSpec = {
  name: "keepdeck",
  transport: "stdio",
  command: "/bin/keepdeck",
  args: ["--mcp-shim", "/sock"],
};
const remote: McpHttpServerSpec = {
  name: "github",
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
};

describe("mapMcpServers", () => {
  it("visits each server by its transport, in the order given", () => {
    // ORDER is part of the contract: every CLI keys its servers by name and
    // the built-in one is contributed first, so a renderer that reordered
    // would let a later entry take precedence in some CLI and not another.
    const visited = mapMcpServers([local, remote, local], {
      stdio: (server) => `stdio:${server.name}`,
      http: (server) => `http:${server.name}`,
    });
    expect(visited).toEqual(["stdio:keepdeck", "http:github", "stdio:keepdeck"]);
  });

  it("refuses a transport no visitor was written for", () => {
    // Unreachable through the type — that is the point of the `never`
    // branch — but a spec that arrived over a wire with a transport this
    // build does not know must be a loud refusal, not a silent skip.
    const foreign = { name: "x", transport: "grpc" } as unknown as McpServerSpec;
    expect(() =>
      mapMcpServers([foreign], { stdio: () => 0, http: () => 0 }),
    ).toThrow("unsupported MCP transport: grpc");
  });

  it("does not compile without an http visitor", () => {
    // The whole reason the fan-out exists: a dialect that forgets an arm is
    // stopped here, at build time, rather than emitting a config with the
    // server missing.
    // @ts-expect-error — the http arm is required
    mapMcpServers([], { stdio: () => 0 });
  });
});

describe("mcpHttpHeaders", () => {
  const ref = (name: string) => `\${${name}}`;

  it("folds the bearer token into Authorization in the CLI's own env syntax", () => {
    expect(mcpHttpHeaders({ bearerTokenEnv: "GH_TOKEN" }, ref)).toEqual({
      Authorization: "Bearer ${GH_TOKEN}",
    });
  });

  it("keeps literal headers beside it", () => {
    expect(
      mcpHttpHeaders(
        { headers: { "X-Org": "keepdeck" }, bearerTokenEnv: "GH_TOKEN" },
        ref,
      ),
    ).toEqual({ "X-Org": "keepdeck", Authorization: "Bearer ${GH_TOKEN}" });
  });

  it("lets the bearer win over a literal Authorization header", () => {
    // Two spellings of one credential would otherwise reach the CLI in
    // whichever order the map happened to keep.
    expect(
      mcpHttpHeaders(
        { headers: { Authorization: "Basic abc" }, bearerTokenEnv: "GH_TOKEN" },
        ref,
      ),
    ).toEqual({ Authorization: "Bearer ${GH_TOKEN}" });
  });

  it("answers undefined when there is nothing to send", () => {
    // So a renderer can leave the key out rather than emit an empty map —
    // which at least one strict config schema would refuse.
    expect(mcpHttpHeaders({}, ref)).toBeUndefined();
    expect(mcpHttpHeaders({ headers: {} }, ref)).toBeUndefined();
  });
});
