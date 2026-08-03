import { mapMcpServers, type McpServerSpec } from "@keepdeck/plugin-api";

/**
 * kimi's dialect — the one that lives host-side rather than in its plugin.
 *
 * Every other CLI takes its servers through argv or env, which is a hook's
 * business. kimi has neither: its loader reads `<cwd>/.kimi-code/mcp.json`, so
 * the delivery is a FILE, and files in a pane's working directory are written
 * by the host (plugins have no such capability, and the ordering against
 * worktree teardown is the worktree owner's invariant). The same split codex
 * already has for skills: the host plants, the plugin contributes nothing.
 */
export const KIMI_AGENT = "kimi";

/** The `mcp.json` body for one pane, in kimi's own shape (`mcpServers`, keyed
 * by name — the format claude's config also uses, which is why kimi calls the
 * repo-root variant "Claude-compatible"). */
export function kimiMcpConfig(servers: readonly McpServerSpec[]): string {
  const mcpServers = Object.fromEntries(
    mapMcpServers(servers, {
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
