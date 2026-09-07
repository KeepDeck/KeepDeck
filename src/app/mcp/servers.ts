/**
 * The rule a set of MCP server declarations must satisfy before it can be
 * rendered into any client config: every CLI keys its servers by name, so
 * the set may hold each name once, and only names every client accepts.
 *
 * Adapter policy, not domain — it is about a FOREIGN format, and changes when
 * an agent CLI changes — which is why it sits beside the renderers it guards.
 * The name grammar itself is the domain's (`isValidMcpServerName`): the
 * library authors names against the same rule, and two homes for it had
 * already drifted once.
 *
 * The SHAPE it works on is `McpServerSpec` from the plugin API — the same type
 * the hooks receive. A second structurally-identical declaration here would
 * typecheck against every renderer while silently dropping any field only one
 * of them knew about.
 */
import type { McpServerSpec } from "@keepdeck/plugin-api";
import { isValidMcpServerName } from "../../domain/mcp";

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
