/**
 * The server dialog's scope groups — which rows the nav shows, under which
 * heading, in which order — and the words the nav says about them.
 *
 * A pure function of the listed library, the active workspace and the
 * bundled tier: no React, no store. The ORDER is a rule about the library
 * (user content outranks app content), not about the dialog that renders it.
 */
import type { McpLibraryRow } from "../../app/mcpLibrary";
import { mcpScopeKey, sameMcpScope, type McpScope } from "../../domain/mcp";
import type { LibraryNavCopy, LibraryNavGroup } from "../library/LibraryNav";
import { BUNDLED_PENDING } from "./bundledTier";
import { sameMcpEditorScope, type McpEditorScope, type McpRow } from "./mcpRows";

export interface GroupWorkspace {
  id: string;
  name: string;
}

export type McpNavGroup = LibraryNavGroup<McpEditorScope, McpScope, McpRow>;

/** Global, the active workspace when there is one, then Bundled — the tier
 * last because user content outranks app content on the user's machine, and
 * with no scope to create into: nothing is authored into it. */
export function buildMcpGroups(
  servers: McpLibraryRow[] | null,
  activeWs: GroupWorkspace | null,
  bundled: McpRow[],
): McpNavGroup[] {
  const all = servers ?? [];
  const inScope = (scope: McpScope) => all.filter((row) => sameMcpScope(row.scope, scope));
  const global: McpScope = { kind: "global" };
  const groups: McpNavGroup[] = [
    { label: "Global", scope: global, items: inScope(global), createScope: global },
  ];
  if (activeWs) {
    const scope: McpScope = { kind: "workspace", wsId: activeWs.id };
    groups.push({ label: activeWs.name, scope, items: inScope(scope), createScope: scope });
  }
  groups.push({ label: "Bundled", scope: { kind: "bundled" }, items: bundled, createScope: null });
  return groups;
}

/** The heading a scope is shown under, from the GROUPS — the one place that
 * knows which workspace a scope belongs to. */
export function labelForMcpScope(groups: McpNavGroup[], scope: McpEditorScope): string {
  return groups.find((group) => sameMcpEditorScope(group.scope, scope))?.label ?? "Workspace";
}

/** One line under a row's name: what the server runs or reaches, why the
 * file could not be read — or, for a bundled server, that it is not up yet. */
export function describeMcpRow(row: McpRow): string {
  if (row.verdict.kind === "pending") return BUNDLED_PENDING;
  if (row.verdict.kind === "malformed") return `Cannot be read — ${row.verdict.reason}`;
  const { body } = row.verdict;
  if (body.transport === "http") return body.url;
  return [body.command, ...body.args].join(" ").trim();
}

export const MCP_NAV_COPY: LibraryNavCopy<McpEditorScope, McpScope, McpRow> = {
  ariaLabel: "MCP servers library",
  scopeKey: (scope) => (scope.kind === "bundled" ? "bundled" : mcpScopeKey(scope)),
  describe: describeMcpRow,
  createTitle: (scope) => `New ${scope.kind === "global" ? "global" : "workspace"} server`,
  emptyCopy: (scope) =>
    scope.kind === "bundled"
      ? "Servers KeepDeck ships with"
      : scope.kind === "global"
        ? "Nothing here yet — a global server reaches every workspace"
        : "Nothing here yet — these stay with this workspace",
};
