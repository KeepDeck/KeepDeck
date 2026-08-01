import { mapMcpServers, type SpawnMcpInput } from "@keepdeck/plugin-api";

/**
 * The injected MCP servers as an opencode config fragment.
 *
 * opencode merges `OPENCODE_CONFIG_CONTENT` LAST, at local scope, into the
 * config it has already assembled (bundle-verified on 1.18.10) — so this rides
 * the very env var KeepDeck already sets for the session reporter, and no new
 * door, file or directory is involved.
 *
 * `command` is one array of program + arguments here, which is opencode's own
 * shape for a local server; `environment` is its name for the env map.
 */
export function mcpConfigFragment(
  mcp: SpawnMcpInput | undefined,
): { mcp: Record<string, unknown> } | null {
  if (!mcp || mcp.servers.length === 0) return null;
  return {
    mcp: Object.fromEntries(
      mapMcpServers(mcp.servers, {
        stdio: (server) => [
          server.name,
          {
            type: "local",
            command: [server.command, ...server.args],
            enabled: true,
            ...(server.env ? { environment: server.env } : {}),
          },
        ],
      }),
    ),
  };
}
