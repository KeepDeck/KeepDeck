/**
 * The server dialog's scope groups — which rows the nav shows, under which
 * heading, in which order — and the words the nav says about them.
 *
 * A pure function of the listed library, the active workspace and the
 * bundled tier: no React, no store. The ORDER is a rule about the library
 * (user content outranks app content), not about the dialog that renders it.
 */
import { KEEPDECK_MCP_SERVER } from "../../app/mcp/bundled";
import type { McpLibraryRow } from "../../app/mcpLibrary";
import { mcpScopeKey, sameMcpScope, type McpScope } from "../../domain/mcp";
import type { McpConnection } from "../../ipc/mcp";
import type { LibraryNavCopy, LibraryNavGroup } from "../library/LibraryNav";
import type { McpEditorScope, McpRow } from "./mcpForm";

export interface GroupWorkspace {
  id: string;
  name: string;
}

export type McpNavGroup = LibraryNavGroup<McpEditorScope, McpRow>;

/**
 * The bundled tier as rows: the deck's own server, with the invocation the
 * backend hands out — or, until the socket is confirmed, an empty one the
 * panel explains. Always present: the tier ships with the app.
 */
export function bundledMcpRows(connect: McpConnection | null): McpRow[] {
  return [
    {
      scope: { kind: "bundled" },
      name: KEEPDECK_MCP_SERVER,
      verdict: {
        kind: "ok",
        body: {
          transport: "stdio",
          command: connect?.command ?? "",
          args: connect?.args ?? [],
          env: {},
        },
      },
    },
  ];
}

/** Global, the active workspace when there is one, then Bundled — the tier
 * last because user content outranks app content on the user's machine. */
export function buildMcpGroups(
  servers: McpLibraryRow[] | null,
  activeWs: GroupWorkspace | null,
  bundled: McpRow[],
): McpNavGroup[] {
  const all = servers ?? [];
  const inScope = (scope: McpScope) => all.filter((row) => sameMcpScope(row.scope, scope));
  const groups: McpNavGroup[] = [
    { label: "Global", scope: { kind: "global" }, items: inScope({ kind: "global" }), canCreate: true },
  ];
  if (activeWs) {
    const scope: McpScope = { kind: "workspace", wsId: activeWs.id };
    groups.push({ label: activeWs.name, scope, items: inScope(scope), canCreate: true });
  }
  groups.push({ label: "Bundled", scope: { kind: "bundled" }, items: bundled, canCreate: false });
  return groups;
}

/** The heading a scope is shown under, from the GROUPS — the one place that
 * knows which workspace a scope belongs to. */
export function labelForMcpScope(groups: McpNavGroup[], scope: McpEditorScope): string {
  return groups.find((group) => sameEditorScope(group.scope, scope))?.label ?? "Workspace";
}

const sameEditorScope = (a: McpEditorScope, b: McpEditorScope): boolean =>
  a.kind === "bundled" || b.kind === "bundled" ? a.kind === b.kind : sameMcpScope(a, b);

/** One line under a row's name: what the server runs or reaches, or why the
 * file could not be read. */
export function describeMcpRow(row: McpRow): string {
  if (row.verdict.kind === "malformed") return `Cannot be read — ${row.verdict.reason}`;
  const { body } = row.verdict;
  if (body.transport === "http") return body.url;
  return [body.command, ...body.args].join(" ").trim() || "starting up…";
}

export const MCP_NAV_COPY: LibraryNavCopy<McpEditorScope, McpRow> = {
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
