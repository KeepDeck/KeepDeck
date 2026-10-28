import { mapMcpServers, type CwdArm, type SpawnMcpInput, type McpServerSpec } from "@keepdeck/plugin-api";

/**
 * kimi's MCP delivery. kimi takes servers on neither argv nor env: its loader
 * reads `<cwd>/.kimi-code/mcp.json`. So this plugin renders that file and
 * declares it for the pane's cwd (`arm.plan`); the host plants it — beside its
 * marker, never over a config of the user's, kept out of git, taken back with
 * the worktree. The manifest says the delivery is the cwd
 * (`integration.mcp` → `delivery: "cwd"`), which is how the host knows a
 * folder shared by two panes cannot carry a per-pane secret.
 */

/** Where kimi reads its MCP config, relative to the pane's cwd. */
export const KIMI_MCP_PATH = ".kimi-code/mcp.json";

/** The pane's MCP file, or nothing — no servers means no file, and a file an
 * earlier launch planted is taken back. */
export function kimiMcpArms(mcp: SpawnMcpInput | undefined): CwdArm[] {
  const servers = mcp?.servers ?? [];
  return servers.length > 0 ? [{ kind: "file", path: KIMI_MCP_PATH, content: kimiMcpConfig(servers) }] : [];
}

/** The `mcp.json` body for one pane, in kimi's own shape (`mcpServers`, keyed
 * by name — the format claude's config also uses, which is why kimi calls the
 * repo-root variant "Claude-compatible").
 *
 * A remote server names its `transport` outright — kimi's loader discriminates
 * on that field — and carries the bearer token as `bearerTokenEnvVar`, kimi's
 * own token-from-env field, so the value stays in the pane's environment. A
 * stdio server's `envPassthrough` renders nothing: kimi hands its MCP children
 * its whole environment.
 *
 * ASSUMED LOADER: kimi-code 0.31.1, where every claim above was probed. The
 * field names are kimi's, not a standard's, and a loader that renames one
 * does not fail — it silently drops the server, or reads the token from
 * nowhere. Re-probe against a new kimi before trusting a changed shape. */
export function kimiMcpConfig(servers: readonly McpServerSpec[]): string {
  const mcpServers = Object.fromEntries(
    mapMcpServers<[string, Record<string, unknown>]>(servers, {
      stdio: (server) => [server.name, { command: server.command, args: server.args }],
      http: (server) => [
        server.name,
        {
          transport: "http",
          url: server.url,
          ...(server.headers ? { headers: server.headers } : {}),
          ...(server.bearerTokenEnv
            ? { bearerTokenEnvVar: server.bearerTokenEnv }
            : {}),
        },
      ],
    }),
  );
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}
