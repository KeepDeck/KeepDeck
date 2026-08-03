/**
 * The rules a set of MCP server declarations must satisfy before it can be
 * rendered into any client config.
 *
 * Adapter policy, not domain: every rule here is about a FOREIGN format. The
 * name grammar is what external tool-name conventions accept, and the
 * duplicate rule exists because every CLI's config keys its servers by name.
 * Neither sentence contains any KeepDeck vocabulary, and both change when an
 * agent CLI changes — an outermost-ring event, which is why this sits beside
 * the renderers it guards rather than in the innermost ring. (Pure, tested and
 * framework-free are not what makes something domain.)
 *
 * The SHAPE it works on is `McpServerSpec` from the plugin API — the same type
 * the hooks receive. A second structurally-identical declaration here would
 * typecheck against every renderer while silently dropping any field only one
 * of them knew about.
 */
import type { McpServerSpec } from "@keepdeck/plugin-api";

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
export function acceptMcpServers(defs: readonly McpServerSpec[]): {
  accepted: McpServerSpec[];
  rejected: McpServerRejection[];
} {
  const accepted: McpServerSpec[] = [];
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
