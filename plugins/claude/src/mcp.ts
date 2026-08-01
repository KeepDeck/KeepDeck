import { mapMcpServers, type SpawnMcpInput } from "@keepdeck/plugin-api";

/**
 * The injected MCP servers, as `--mcp-config` takes them.
 *
 * The flag accepts a JSON STRING as well as a file path (probe-verified on
 * 2.1.220: the server connects and its tools appear as `mcp__<name>__…`, with
 * no approval prompt), so nothing is staged on disk for this — the whole
 * declaration rides argv.
 *
 * `--strict-mcp-config` is deliberately NOT passed: it would restrict the
 * session to the servers below and silence every server the user configured
 * themselves.
 */
export const mcpArgs = (mcp: SpawnMcpInput | undefined): string[] => {
  if (!mcp || mcp.servers.length === 0) return [];
  const mcpServers = Object.fromEntries(
    mapMcpServers(mcp.servers, {
      stdio: (server) => [
        server.name,
        {
          command: server.command,
          args: server.args,
          ...(server.env ? { env: server.env } : {}),
        },
      ],
    }),
  );
  return ["--mcp-config", JSON.stringify({ mcpServers })];
};
