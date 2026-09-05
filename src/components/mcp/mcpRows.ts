/**
 * The rows the server dialog lists — the library's servers and the bundled
 * tier under one shape, so one nav shows both — and the scope vocabulary
 * that goes with them.
 *
 * Presentation, not domain: the domain knows the two scopes a server is
 * STORED in; the dialog adds the tier KeepDeck ships, which is read-only and
 * not a library at all. Every "which row is this" and "same scope?" question
 * the dialog asks is answered here, once.
 */
import { sameMcpScope, type McpScope, type McpServerVerdict } from "../../domain/mcp";

/** The scopes the dialog shows: the two the library stores, and the tier
 * KeepDeck ships. A write never names the tier — see the machine's
 * `WriteScope`, which is the domain's [`McpScope`] alone. */
export type McpEditorScope = McpScope | { kind: "bundled" };

/** What a listed row holds: a stored file's verdict, or — for a bundled
 * server whose gate is closed — nothing yet. `pending` is the tier's own
 * state, never a file's. */
export type McpRowVerdict = McpServerVerdict | { kind: "pending" };

/** One row as the dialog lists it. */
export interface McpRow {
  scope: McpEditorScope;
  name: string;
  verdict: McpRowVerdict;
}

/** Whether two dialog scopes name the same library or tier. */
export function sameMcpEditorScope(a: McpEditorScope, b: McpEditorScope): boolean {
  if (a.kind === "bundled" || b.kind === "bundled") return a.kind === b.kind;
  return sameMcpScope(a, b);
}

/** The listed row at (scope, name) — "which row IS this one" asked once. */
export function mcpRowAt(
  rows: McpRow[] | null,
  scope: McpEditorScope,
  name: string,
): McpRow | undefined {
  return (rows ?? []).find((row) => row.name === name && sameMcpEditorScope(row.scope, scope));
}
