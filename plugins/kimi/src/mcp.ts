import {
  mapMcpServers,
  type AgentMcpFileDelivery,
  type SpawnMcpInput,
} from "@keepdeck/plugin-api";

/**
 * kimi's MCP dialect: a FILE, because its CLI has no flag and no env for
 * servers.
 *
 * kimi 0.31's loader reads `<cwd>/.kimi-code/mcp.json` (plus two paths
 * KeepDeck must not touch — the user's own home config, and the repo-shared
 * `.mcp.json` claude also reads). Declaring the delivery here rather than
 * naming kimi in the host is what keeps the host free of agent literals: this
 * plugin owns the path and the body, exactly as the other three own their
 * argv, and the host owns only the ordering of the write against a worktree
 * teardown — which is its invariant, not ours.
 */
export const mcpFileDelivery: AgentMcpFileDelivery = {
  dir: ".kimi-code",
  name: "mcp.json",
  render: mcpConfig,
};

/** The `mcp.json` body, in kimi's own shape (`mcpServers`, keyed by name —
 * the format claude's config also uses, which is why kimi calls the repo-root
 * variant "Claude-compatible"). */
export function mcpConfig(mcp: SpawnMcpInput): string {
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
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}
