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
 *
 * Host-side is the SETTLED place for the format, not a priced-shut door: a
 * plugin-declared one was designed and rejected — it would have carried the
 * shape as wire strings, trading a compile error for a silent mismatch the day
 * a second dialect arrives. What the host owes instead is that no flow names
 * an agent: it asks [`mcpFileRenderer`], and the Rust side asks its own view
 * (`mcp/kimi.rs`). A second dialect adds a module beside this one.
 */
const KIMI_AGENT = "kimi";

/** Renders one pane's servers into the body its CLI reads from disk. */
export type McpFileRenderer = (servers: readonly McpServerSpec[]) => string;

/**
 * How this agent's servers reach it: a renderer when the CLI is fed by a FILE
 * in the pane's cwd, `null` when it takes them on argv.
 *
 * The question the injection flow asks, so it never names an agent. Everything
 * that follows from the answer — that a shared cwd holds one file and so one
 * secret, that nothing rides argv — follows from file delivery as a CLASS, not
 * from which CLI happens to be file-fed today.
 */
export function mcpFileRenderer(agentType: string): McpFileRenderer | null {
  return agentType === KIMI_AGENT ? kimiMcpConfig : null;
}

/** The `mcp.json` body for one pane, in kimi's own shape (`mcpServers`, keyed
 * by name — the format claude's config also uses, which is why kimi calls the
 * repo-root variant "Claude-compatible").
 *
 * A remote server names its `transport` outright — kimi's loader discriminates
 * on that field — and carries the bearer token as `bearerTokenEnvVar`, kimi's
 * own token-from-env field, so the value stays in the pane's environment. A
 * stdio server's `envPassthrough` renders nothing: kimi hands its MCP children
 * its whole environment (probe-verified on 0.31.1). */
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
