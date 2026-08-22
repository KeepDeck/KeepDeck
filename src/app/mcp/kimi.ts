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
 * That proof establishes HOST-MUST-WRITE, not HOST-DECIDES-FORMAT: a future
 * plugin-owned format remains a possible door (the shared-mcp v2 precedent),
 * but we price it shut here on lifecycle grounds. If another dialect arrives,
 * emitter hygiene is one module plus one match arm, not branches spread across
 * the host; its lifecycle must first make the door worth opening.
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
