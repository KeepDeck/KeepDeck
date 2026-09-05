import { describe, expect, it } from "vitest";
import {
  MCP_SPEC_SHAPE,
  composeMcpServerFile,
  isValidMcpServerName,
  mcpScopeKey,
  mcpScopeOf,
  mcpServerBodyProblem,
  mcpServerNameProblem,
  mcpServerSummary,
  parseMcpServerFile,
  sameMcpScope,
  type McpServerBody,
} from "./library";

const stdio: McpServerBody = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" },
};
const http: McpServerBody = {
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  headers: { "X-Org": "keepdeck" },
  bearerToken: "ghp_y",
};

describe("scopes", () => {
  it("compares by kind and workspace", () => {
    expect(sameMcpScope({ kind: "global" }, { kind: "global" })).toBe(true);
    expect(sameMcpScope({ kind: "global" }, { kind: "workspace", wsId: "ws-1" })).toBe(false);
    expect(
      sameMcpScope({ kind: "workspace", wsId: "ws-1" }, { kind: "workspace", wsId: "ws-1" }),
    ).toBe(true);
    expect(
      sameMcpScope({ kind: "workspace", wsId: "ws-1" }, { kind: "workspace", wsId: "ws-2" }),
    ).toBe(false);
  });

  it("reads a stored row's two columns as one scope, and keys it", () => {
    expect(mcpScopeOf({ scope: "global", wsId: null })).toEqual({ kind: "global" });
    expect(mcpScopeOf({ scope: "workspace", wsId: "ws-3" })).toEqual({
      kind: "workspace",
      wsId: "ws-3",
    });
    // A workspace row with no id matches no real workspace.
    expect(mcpScopeOf({ scope: "workspace", wsId: null })).toEqual({
      kind: "workspace",
      wsId: "",
    });
    expect(mcpScopeKey({ kind: "global" })).toBe("global");
    expect(mcpScopeKey({ kind: "workspace", wsId: "ws-3" })).toBe("ws:ws-3");
  });
});

describe("the name rule", () => {
  it("is the intersection of every client's grammar and the path wall", () => {
    expect(isValidMcpServerName("keepdeck")).toBe(true);
    expect(isValidMcpServerName("my-server_2")).toBe(true);
    // A dot is the one that matters: tool names flatten namespaces with
    // underscores precisely because external grammars refuse dots.
    expect(isValidMcpServerName("my.server")).toBe(false);
    expect(isValidMcpServerName("")).toBe(false);
    expect(isValidMcpServerName("has space")).toBe(false);
    // The path wall's half: a plain segment starts alphanumeric.
    expect(isValidMcpServerName("-lead")).toBe(false);
    expect(isValidMcpServerName("_lead")).toBe(false);
    expect(isValidMcpServerName("x".repeat(64))).toBe(true);
    expect(isValidMcpServerName("x".repeat(65))).toBe(false);
  });

  it("tells empty from invalid, so a form can say which", () => {
    expect(mcpServerNameProblem("  ")).toBe("empty");
    expect(mcpServerNameProblem("my.server")).toBe("invalid");
    expect(mcpServerNameProblem("github")).toBeNull();
  });
});

describe("the body rule", () => {
  it("names the field a caller left empty", () => {
    expect(mcpServerBodyProblem({ ...stdio, command: " " })).toBe("empty-command");
    expect(mcpServerBodyProblem({ ...http, url: "" })).toBe("empty-url");
    expect(mcpServerBodyProblem(stdio)).toBeNull();
    expect(mcpServerBodyProblem(http)).toBeNull();
  });

  it("refuses a literal Authorization header beside a bearer token, whatever its case", () => {
    // Two of the dialects fold the token into the header and two hand the
    // CLI both; refused here so no dialect has to decide which wins.
    expect(
      mcpServerBodyProblem({ ...http, headers: { authorization: "Basic x" } }),
    ).toBe("two-credentials");
    expect(
      mcpServerBodyProblem({ ...http, headers: { Authorization: "Basic x" }, bearerToken: undefined }),
    ).toBeNull();
  });
});

describe("the spec shape in words", () => {
  it("names every key the codec accepts, per transport", () => {
    expect(MCP_SPEC_SHAPE).toBe(
      '{"transport":"stdio","command":…,"args":…,"env":…} or {"transport":"http","url":…,"headers":…,"bearerToken":…}',
    );
  });
});

describe("the summary a door may hand out", () => {
  it("names a spawned server's variables and never their values", () => {
    expect(mcpServerSummary(stdio)).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    });
  });

  it("says whether an endpoint has a token, never what it is", () => {
    expect(mcpServerSummary(http)).toEqual({
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { "X-Org": "keepdeck" },
      bearerToken: true,
    });
    expect(mcpServerSummary({ ...http, bearerToken: undefined })).toMatchObject({
      bearerToken: false,
    });
  });
});

describe("the stored file", () => {
  it("round-trips both transports through compose and parse", () => {
    expect(parseMcpServerFile(composeMcpServerFile(stdio))).toEqual({ kind: "ok", body: stdio });
    expect(parseMcpServerFile(composeMcpServerFile(http))).toEqual({ kind: "ok", body: http });
  });

  it("writes a stable, hand-editable document and leaves empty maps out", () => {
    const text = composeMcpServerFile({ ...stdio, env: {} });
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
    const remote = JSON.parse(composeMcpServerFile({ transport: "http", url: "u", headers: {} }));
    expect(remote).toEqual({ transport: "http", url: "u" });
  });

  it("reads a minimal hand-written file, defaults filled in", () => {
    expect(parseMcpServerFile('{"transport":"stdio","command":"mnemo-mcp"}')).toEqual({
      kind: "ok",
      body: { transport: "stdio", command: "mnemo-mcp", args: [], env: {} },
    });
    expect(parseMcpServerFile('{"transport":"http","url":"https://x/"}')).toEqual({
      kind: "ok",
      body: { transport: "http", url: "https://x/", headers: {} },
    });
  });

  it("refuses what no renderer could carry, and says why", () => {
    // The class the reference implementation shipped: a free-form key that
    // one strict CLI schema then refused, taking every server with it.
    const cases: [string, string][] = [
      ["not json", "not valid JSON"],
      ["[]", "must hold a JSON object"],
      ['{"transport":"sse","url":"u"}', '"transport" must be "stdio" or "http"'],
      ['{"transport":"stdio","command":"x","startup_timeout_sec":"30"}', 'unknown field "startup_timeout_sec"'],
      ['{"transport":"stdio"}', '"command" must be a non-empty string'],
      ['{"transport":"stdio","command":"x","args":"-y"}', '"args" must be an array of strings'],
      ['{"transport":"stdio","command":"x","args":null}', '"args" must be an array of strings'],
      ['{"transport":"stdio","command":"x","env":{"A":1}}', '"env" must be an object of strings'],
      ['{"transport":"http"}', '"url" must be a non-empty string'],
      ['{"transport":"http","url":"u","headers":[]}', '"headers" must be an object of strings'],
      ['{"transport":"http","url":"u","bearerToken":""}', '"bearerToken" must be a non-empty string'],
      [
        '{"transport":"http","url":"u","headers":{"AUTHORIZATION":"Basic x"},"bearerToken":"t"}',
        "one credential per server",
      ],
    ];
    for (const [content, reason] of cases) {
      const verdict = parseMcpServerFile(content);
      expect(verdict.kind, content).toBe("malformed");
      if (verdict.kind === "malformed") expect(verdict.reason, content).toContain(reason);
    }
  });

  it("never repeats the file's bytes in a reason", () => {
    // V8 quotes the text around a JSON error; in this file that text may be
    // a token, and the reason travels into the log and out through a command.
    const verdict = parseMcpServerFile('{"transport":"http","url":"u","bearerToken":sk-live-SECRET}');
    expect(verdict.kind).toBe("malformed");
    if (verdict.kind === "malformed") {
      expect(verdict.reason).toBe("not valid JSON");
      expect(verdict.reason).not.toContain("SECRET");
    }
  });
});
