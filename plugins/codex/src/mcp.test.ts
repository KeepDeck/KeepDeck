import { describe, expect, it, vi } from "vitest";
import type { SpawnMcpInput } from "@keepdeck/plugin-api";
import { mcpArgs } from "./mcp";

const input = (...servers: SpawnMcpInput["servers"]): SpawnMcpInput => ({
  servers,
});

const server = (name: string): SpawnMcpInput["servers"][number] => ({
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

  it("declares env explicitly — codex does not pass its own to MCP children", () => {
    // Probe-verified on 0.146: the child gets a core allowlist only, so a
    // value left to inheritance reaches three CLIs and not this one.
    const withEnv = { ...server("keepdeck"), env: { KD_PANE: "pane-3" } };
    expect(mcpArgs(input(withEnv))[1]).toContain('env={"KD_PANE"="pane-3"}');
  });

  it("adds nothing when there is nothing to inject", () => {
    expect(mcpArgs(undefined)).toEqual([]);
    expect(mcpArgs(input())).toEqual([]);
  });
});
