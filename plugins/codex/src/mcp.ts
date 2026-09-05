import {
  mapMcpServers,
  type McpHttpServerSpec,
  type McpStdioServerSpec,
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

const tomlArray = (values: readonly string[]): string =>
  `[${values.map(tomlString).join(",")}]`;

function tomlInlineTable(entries: readonly [string, string][]): string {
  return `{${entries.map(([key, value]) => `${key}=${value}`).join(",")}}`;
}

/** A string→string map as an inline table, both sides quoted. */
const tomlStringTable = (map: Record<string, string>): string =>
  tomlInlineTable(
    Object.entries(map).map(([key, value]) => [tomlString(key), tomlString(value)]),
  );

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

/**
 * The table for a locally spawned server.
 *
 * `env` is declared explicitly because codex does NOT pass its own
 * environment to MCP children: they get a core allowlist only (HOME, PATH,
 * LANG, USER, SHELL, TMPDIR, TERM, PWD, LOGNAME), so anything the server
 * needs has to be in the table. `env_vars` is the allowlist's own door — the
 * names listed there are forwarded from codex's environment, which is the
 * pane's, so a value the host put there reaches the server without ever
 * appearing on argv.
 */
function stdioTable(server: McpStdioServerSpec): [string, string][] {
  const entries: [string, string][] = [
    ["command", tomlString(server.command)],
    ["args", tomlArray(server.args)],
  ];
  if (server.env) entries.push(["env", tomlStringTable(server.env)]);
  if (server.envPassthrough?.length) {
    entries.push(["env_vars", tomlArray(server.envPassthrough)]);
  }
  return entries;
}

/** The table for a remote server: `url`, codex's own token-from-env field,
 * and literal headers under its name for them. */
function httpTable(server: McpHttpServerSpec): [string, string][] {
  const entries: [string, string][] = [["url", tomlString(server.url)]];
  if (server.bearerTokenEnv) {
    entries.push(["bearer_token_env_var", tomlString(server.bearerTokenEnv)]);
  }
  if (server.headers) entries.push(["http_headers", tomlStringTable(server.headers)]);
  return entries;
}

/**
 * The injected MCP servers, as codex config overrides.
 *
 * `-c mcp_servers.<name>={…}` MERGES with the servers the user has in their
 * own `~/.codex/config.toml` (probe-verified on 0.146: the injected one shows
 * up in `codex mcp list` next to theirs), and nothing is written anywhere —
 * which is why this door is used rather than the project-local config file
 * codex gates behind trust.
 */
export const mcpArgs = (
  mcp: SpawnMcpInput | undefined,
  logger?: Pick<PluginLogger, "warn">,
): string[] => {
  if (!mcp) return [];
  /** One override, or nothing for a name codex could not take — and one bad
   * name does not take its siblings with it. */
  const override = (name: string, table: [string, string][]): string[] => {
    if (!CODEX_SERVER_NAME.test(name)) {
      logger?.warn(
        `skipping MCP server ${name}: Codex names must match ${CODEX_SERVER_NAME}`,
      );
      return [];
    }
    return ["-c", `mcp_servers.${name}=${tomlInlineTable(table)}`];
  };
  return mapMcpServers(mcp.servers, {
    stdio: (server) => override(server.name, stdioTable(server)),
    http: (server) => override(server.name, httpTable(server)),
  }).flat();
};
