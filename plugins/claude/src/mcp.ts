import {
  mapMcpServers,
  mcpHttpHeaders,
  type SpawnMcpInput,
} from "@keepdeck/plugin-api";

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
 *
 * A remote server is `type: "http"` with its url and headers. Its bearer
 * token is referenced as `${VAR}`, which claude expands from ITS environment
 * — the pane's — so the value never enters the argument. A stdio server's
 * `envPassthrough` renders nothing: claude hands its MCP children its whole
 * environment (probe-verified on 2.1.220), so what the host put there arrives
 * on its own.
 */
/** One `mcpServers` entry: the name, and the body in claude's shape. */
type Entry = [string, Record<string, unknown>];

export const mcpArgs = (mcp: SpawnMcpInput | undefined): string[] => {
  if (!mcp || mcp.servers.length === 0) return [];
  const mcpServers = Object.fromEntries(
    mapMcpServers<Entry>(mcp.servers, {
      stdio: (server) => [server.name, { command: server.command, args: server.args }],
      http: (server) => {
        const headers = mcpHttpHeaders(server, (name) => `\${${name}}`);
        return [
          server.name,
          {
            type: "http",
            url: server.url,
            ...(headers ? { headers } : {}),
          },
        ];
      },
    }),
  );
  return ["--mcp-config", JSON.stringify({ mcpServers })];
};
