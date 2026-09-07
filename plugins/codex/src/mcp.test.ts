import { describe, expect, it, vi } from "vitest";
import type { McpStdioServerSpec, SpawnMcpInput } from "@keepdeck/plugin-api";
import { mcpArgs } from "./mcp";

const input = (...servers: SpawnMcpInput["servers"]): SpawnMcpInput => ({
  servers,
});

const server = (name: string): McpStdioServerSpec => ({
  name,
  transport: "stdio",
  command: "/bin/keepdeck",
  args: ["--mcp-shim", "/home/mcp.sock"],
});

describe("codex MCP overrides", () => {
  it("emits one -c override per server, not one for the first", () => {
    // The bank contributes more members than the built-in transport; a
    // renderer that emitted a single entry would drop the rest silently.
    expect(mcpArgs(input(server("keepdeck"), server("mnemo")))).toEqual([
      "-c",
      'mcp_servers.keepdeck={command="/bin/keepdeck",args=["--mcp-shim","/home/mcp.sock"]}',
      "-c",
      'mcp_servers.mnemo={command="/bin/keepdeck",args=["--mcp-shim","/home/mcp.sock"]}',
    ]);
  });

  it("leaves the server NAME bare — codex reads the key literally", () => {
    // This test used to assert the opposite, and it was pinning a belief
    // rather than a behaviour: a quoted key IS valid TOML for the unquoted
    // name, so quoting looked like the careful choice. codex does not
    // unquote it. On a live pane it answered `Invalid MCP server name
    // '"keepdeck"': must match pattern ^[a-zA-Z0-9_-]+$` and failed MCP
    // startup entirely — the pane lost every server, not just this one.
    expect(mcpArgs(input(server("keepdeck")))[1]!.startsWith("mcp_servers.keepdeck=")).toBe(
      true,
    );
  });

  it("skips a name codex could not accept, rather than mangling it", () => {
    // There is no encoding codex takes for one — quoting is what it just
    // refused — so the choice is to omit the server or to publish it under
    // a name the deck does not believe it has. A dot would also address a
    // nested table and collide with a sibling inline table.
    expect(mcpArgs(input(server("my.server")))).toEqual([]);
    expect(mcpArgs(input(server('ev"il')))).toEqual([]);
    // ...and one bad name does not take its siblings with it.
    expect(mcpArgs(input(server("my.server"), server("keepdeck")))).toHaveLength(2);
  });

  it("logs a name codex skipped instead of silently dropping it", () => {
    const warn = vi.fn();

    expect(mcpArgs(input(server("my.server")), { warn })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipping MCP server my.server"),
    );
  });

  it("escapes what TOML cannot carry raw", () => {
    // The value is parsed as TOML: an unescaped quote or backslash makes the
    // override a literal string, or refused outright. App bundles on Windows
    // and paths with quotes are the realistic sources.
    const quoted = {
      ...server("keepdeck"),
      command: 'C:\\Program Files\\Keep"Deck\\keepdeck.exe',
      args: ["--mcp-shim", "/tmp/a\tb"],
    };
    expect(mcpArgs(input(quoted))[1]).toBe(
      'mcp_servers.keepdeck={command="C:\\\\Program Files\\\\Keep\\"Deck\\\\keepdeck.exe",' +
        'args=["--mcp-shim","/tmp/a\\tb"]}',
    );
  });

  it("escapes what has no literal form in a TOML basic string", () => {
    // The catch-all must not undo the specific escapes above it: a reordered
    // replace chain would double-escape a newline into a literal backslash-n
    // and codex would receive a path that is not the one we meant.
    //
    // The control characters are written as ESCAPE SEQUENCES, never as literal
    // bytes: a raw NUL in the source makes git treat this whole file as
    // binary, and the one test covering control-character escaping becomes
    // invisible in every diff.
    const odd = {
      ...server("keepdeck"),
      command: "/tmp/line\nbreak\rreturn",
      args: ["\u0000", "\u007f", "", "путь"],
    };
    const override = mcpArgs(input(odd))[1]!;
    expect(override).toContain('command="/tmp/line\\nbreak\\rreturn"');
    expect(override).toContain('args=["\\u0000","\\u007f","","путь"]');
  });

  it("renders a server that takes no arguments and no env", () => {
    const bare = { ...server("keepdeck"), args: [] };
    expect(mcpArgs(input(bare))[1]).toBe(
      'mcp_servers.keepdeck={command="/bin/keepdeck",args=[]}',
    );
  });

  it("adds nothing when there is nothing to inject", () => {
    expect(mcpArgs(undefined)).toEqual([]);
    expect(mcpArgs(input())).toEqual([]);
  });

  it("forwards a passthrough name through env_vars — the allowlist's own door", () => {
    // The value is in the pane's environment; `env_vars` is how codex is told
    // to let it through to the child. It never appears in the override.
    const passthrough = { ...server("gh"), envPassthrough: ["GH_TOKEN", "GH_HOST"] };
    expect(mcpArgs(input(passthrough))[1]).toBe(
      'mcp_servers.gh={command="/bin/keepdeck",args=["--mcp-shim","/home/mcp.sock"],' +
        'env_vars=["GH_TOKEN","GH_HOST"]}',
    );
  });

  it("renders a remote server with url, its token-from-env field and headers", () => {
    // codex's own vocabulary: `bearer_token_env_var` names the variable,
    // `http_headers` carries the literal ones. No `${VAR}` — codex does not
    // expand it, and the native field is what keeps the token off argv.
    const remote = input({
      name: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { "X-Org": "keepdeck" },
      bearerTokenEnv: "GH_TOKEN",
    });
    expect(mcpArgs(remote)).toEqual([
      "-c",
      'mcp_servers.github={url="https://api.githubcopilot.com/mcp/",' +
        'bearer_token_env_var="GH_TOKEN",http_headers={"X-Org"="keepdeck"}}',
    ]);
  });

  it("holds a remote server to the same name rule as a local one", () => {
    const warn = vi.fn();
    expect(
      mcpArgs(
        input({ name: "my.remote", transport: "http", url: "https://mcp.example/" }),
        { warn },
      ),
    ).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("my.remote"));
  });
});
