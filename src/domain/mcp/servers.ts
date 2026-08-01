/**
 * One MCP server as KeepDeck declares it to an agent CLI — and the rules a
 * set of them must satisfy before it can be rendered into any client config.
 *
 * What travels is always a LIST. Today KeepDeck's own transport is its only
 * member, but the planned server bank contributes more, so every renderer
 * loops over what it is given instead of emitting one hardcoded entry.
 *
 * The union has ONE arm on purpose. Remote (http/sse) servers are what the
 * bank will want next, and making `transport` a discriminant now means that
 * the day the second arm lands, every renderer that does not handle it fails
 * to compile — rather than silently dropping the server from one CLI's
 * config while the other three carry it.
 */

/** A locally spawned (stdio) MCP server. */
export interface McpStdioServer {
  /** The key the CLI files this server under, and the prefix its tools
   * appear with (`mcp__<name>__…`). */
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  /** Extra environment for the server process. DECLARED, never assumed to be
   * inherited: codex hands its MCP children a core allowlist only, so a
   * value left to inheritance would reach three CLIs and quietly not the
   * fourth. */
  env?: Record<string, string>;
}

export type McpServerDef = McpStdioServer;

/** External tool-name grammars are `[a-zA-Z0-9_-]` (no dots), and the name
 * becomes part of every tool this server exposes. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidMcpServerName(name: string): boolean {
  return SERVER_NAME.test(name);
}

export type McpServerRejection =
  /** The name would not survive a tool-name grammar. */
  | { name: string; reason: "invalid-name" }
  /** An earlier def already claimed this name. */
  | { name: string; reason: "duplicate-name" };

/**
 * The defs a config may actually carry, in the order given, plus what was
 * dropped and why.
 *
 * Every CLI's config keys its servers BY NAME, so a duplicate is not a
 * near-miss — one entry would overwrite the other, and which one survives
 * would differ per CLI. The first claim wins, which makes the built-in
 * server (contributed first) impossible for a bank entry to shadow.
 */
export function acceptMcpServers(defs: readonly McpServerDef[]): {
  accepted: McpServerDef[];
  rejected: McpServerRejection[];
} {
  const accepted: McpServerDef[] = [];
  const rejected: McpServerRejection[] = [];
  const claimed = new Set<string>();
  for (const def of defs) {
    if (!isValidMcpServerName(def.name)) {
      rejected.push({ name: def.name, reason: "invalid-name" });
      continue;
    }
    if (claimed.has(def.name)) {
      rejected.push({ name: def.name, reason: "duplicate-name" });
      continue;
    }
    claimed.add(def.name);
    accepted.push(def);
  }
  return { accepted, rejected };
}
