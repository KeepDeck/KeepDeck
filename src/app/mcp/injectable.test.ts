import { describe, expect, it } from "vitest";
import { bearerTokenVar, injectableOf } from "./injectable";

describe("a library server as the injection hands it out", () => {
  it("names a spawned server's variables and carries their values beside", () => {
    // The spec declares the names (the passthrough is for the CLI that
    // filters its children's environment); the values go to the pane's
    // environment under the names the server itself reads.
    const { spec, env } = injectableOf("github", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x", GITHUB_HOST: "github.com" },
    });
    expect(spec).toEqual({
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      envPassthrough: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_HOST"],
    });
    expect(env).toEqual([
      ["GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_x"],
      ["GITHUB_HOST", "github.com"],
    ]);
  });

  it("declares no passthrough for a server that needs no variables", () => {
    const { spec, env } = injectableOf("fs", {
      transport: "stdio",
      command: "mcp-fs",
      args: [],
      env: {},
    });
    expect("envPassthrough" in spec).toBe(false);
    expect(env).toEqual([]);
  });

  it("mints a variable for an endpoint's bearer token and carries the token beside", () => {
    const { spec, env } = injectableOf("github-remote", {
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { "X-Org": "keepdeck" },
      bearerToken: "ghp_y",
    });
    expect(spec).toEqual({
      name: "github-remote",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { "X-Org": "keepdeck" },
      bearerTokenEnv: "KEEPDECK_MCP_TOKEN_github_2Dremote",
    });
    expect(env).toEqual([["KEEPDECK_MCP_TOKEN_github_2Dremote", "ghp_y"]]);
  });

  it("leaves headers and the token out of an endpoint that has none", () => {
    const { spec, env } = injectableOf("plain", {
      transport: "http",
      url: "https://mcp.example/",
      headers: {},
    });
    expect(spec).toEqual({ name: "plain", transport: "http", url: "https://mcp.example/" });
    expect(env).toEqual([]);
  });

  it("mints a DISTINCT variable for every distinct name", () => {
    // `github-remote` and `github_remote` used to share one variable, so the
    // pane handed one server the other's token. Hyphen and underscore are
    // spelled as their own hex, and case survives.
    const names = ["github-remote", "github_remote", "github_2Dremote", "GitHub-Remote", "a"];
    const vars = names.map(bearerTokenVar);
    expect(new Set(vars).size).toBe(names.length);
    for (const variable of vars) expect(variable).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(bearerTokenVar("a_b")).toBe("KEEPDECK_MCP_TOKEN_a_5Fb");
  });
});
