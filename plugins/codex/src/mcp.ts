import {
  mapMcpServers,
  type PluginLogger,
  type SpawnMcpInput,
} from "@keepdeck/plugin-api";

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
/**
 * The names codex will accept — its own rule, and it applies to the KEY of a
 * `-c mcp_servers.<name>` override.
 *
 * A quoted key is valid TOML and means the unquoted name, so rendering it
 * that way looked like the careful choice. codex does not read it that way:
 * it takes the segment LITERALLY, quotes included, and refuses it —
 * `Invalid MCP server name '"keepdeck"': must match pattern
 * ^[a-zA-Z0-9_-]+$`, observed on a live pane, with the whole MCP startup
 * failing after it. So the name goes in bare.
 *
 * A name that does not match cannot be injected at all — there is no
 * encoding codex accepts for one — so its server is skipped rather than
 * mangled into a different name than the deck believes it published.
 */
const CODEX_SERVER_NAME = /^[a-zA-Z0-9_-]+$/;

export const mcpArgs = (
  mcp: SpawnMcpInput | undefined,
  logger?: Pick<PluginLogger, "warn">,
): string[] =>
  mcp
    ? mapMcpServers(mcp.servers, {
        stdio: (server) =>
          CODEX_SERVER_NAME.test(server.name)
            ? [
                "-c",
                `mcp_servers.${server.name}=` +
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
              ]
            : (() => {
                logger?.warn(
                  `skipping MCP server ${server.name}: Codex names must match ${CODEX_SERVER_NAME}`,
                );
                return [];
              })(),
      }).flat()
    : [];
