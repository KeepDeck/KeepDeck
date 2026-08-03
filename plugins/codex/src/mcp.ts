import { mapMcpServers, type SpawnMcpInput } from "@keepdeck/plugin-api";

/** One TOML basic string. Codex parses each `-c` value as TOML, so a path
 * with a quote or a backslash has to arrive escaped or the override is read
 * as a literal string — or refused outright. */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // Any other control character has no literal form in a basic string.
    .replace(/[\u0000-\u001f\u007f]/g, (c) =>
      `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  return `"${escaped}"`;
}

function tomlInlineTable(entries: [string, string][]): string {
  return `{${entries.map(([key, value]) => `${key}=${value}`).join(",")}}`;
}

/**
 * The injected MCP servers, as codex config overrides.
 *
 * `-c mcp_servers.<name>={…}` MERGES with the servers the user has in their
 * own `~/.codex/config.toml` (probe-verified on 0.146: the injected one shows
 * up in `codex mcp list` next to theirs), and nothing is written anywhere —
 * which is why this door is used rather than the project-local config file
 * codex gates behind trust.
 *
 * `env` is declared explicitly because codex does NOT pass its own
 * environment to MCP children: they get a core allowlist only (HOME, PATH,
 * LANG, USER, SHELL, TMPDIR, TERM, PWD, LOGNAME), so anything the server
 * needs has to be in the table.
 */
export const mcpArgs = (mcp: SpawnMcpInput | undefined): string[] =>
  mcp
    ? mapMcpServers(mcp.servers, {
        stdio: (server) => [
          "-c",
          // The NAME is a TOML key, not just a value: bare, a dot in it would
          // address a nested table (`mcp_servers.a.b`) instead of naming one
          // server, and would then collide with a sibling inline table. The
          // host constrains names today, but this renderer must not depend on
          // a rule enforced three layers away.
          `mcp_servers.${tomlString(server.name)}=` +
            tomlInlineTable([
              ["command", tomlString(server.command)],
              ["args", `[${server.args.map(tomlString).join(",")}]`],
              ...(server.env
                ? ([
                    [
                      "env",
                      tomlInlineTable(
                        Object.entries(server.env).map(([key, value]) => [
                          tomlString(key),
                          tomlString(value),
                        ]),
                      ),
                    ],
                  ] as [string, string][])
                : []),
            ]),
        ],
      }).flat()
    : [];
