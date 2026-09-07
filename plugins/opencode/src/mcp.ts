import {
  mapMcpServers,
  mcpHttpHeaders,
  type SpawnMcpInput,
} from "@keepdeck/plugin-api";

/**
 * The injected MCP servers as an opencode config fragment.
 *
 * opencode merges `OPENCODE_CONFIG_CONTENT` LAST, at local scope, into the
 * config it has already assembled (bundle-verified on 1.18.10) — so this rides
 * the very env var KeepDeck already sets for the session reporter, and no new
 * door, file or directory is involved.
 *
 * `command` is one array of program + arguments here, which is opencode's own
 * shape for a local server. A
 * remote server is `type: "remote"` with its url and headers; the bearer token
 * is referenced as `{env:VAR}`, opencode's own substitution syntax for a value
 * read from its environment — the pane's — so the token never enters the
 * config. A stdio server's `envPassthrough` renders nothing: opencode hands
 * its MCP children its whole environment (probe-verified on 1.18.10).
 */
/** One `mcp` entry: the name, and the body in opencode's shape. */
type Entry = [string, Record<string, unknown>];

export function mcpConfigFragment(
  mcp: SpawnMcpInput | undefined,
): { mcp: Record<string, unknown> } | null {
  if (!mcp || mcp.servers.length === 0) return null;
  return {
    mcp: Object.fromEntries(
      mapMcpServers<Entry>(mcp.servers, {
        stdio: (server) => [
          server.name,
          { type: "local", command: [server.command, ...server.args], enabled: true },
        ],
        http: (server) => {
          const headers = mcpHttpHeaders(server, (name) => `{env:${name}}`);
          return [
            server.name,
            {
              type: "remote",
              url: server.url,
              enabled: true,
              ...(headers ? { headers } : {}),
            },
          ];
        },
      }),
    ),
  };
}
