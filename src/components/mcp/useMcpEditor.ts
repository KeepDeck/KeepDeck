/**
 * The server editor: the generic library machine ([`useLibraryEditor`])
 * configured for MCP servers — the form is text the draft is built from, a
 * bundled row opens the read-only panel — plus the one derived fact only
 * this shell needs: the nav's groups.
 *
 * The bundled tier is presented THROUGH the machine (a view selection) but
 * is not a library: the machine's write scope is the domain's [`McpScope`],
 * so no write can name the tier — the nav offers it no "+ New", and a view
 * selection carries no scope at all.
 */
import { useMemo } from "react";
import { useBundledMcp } from "../../app/mcp/useBundledMcp";
import { useMcpLibrary } from "../../app/useMcpLibrary";
import type { McpScope, McpServerDraft } from "../../domain/mcp";
import { useLibraryEditor, type LibraryConfirm } from "../library/useLibraryEditor";
import { bundledMcpRows } from "./bundledTier";
import { EMPTY_MCP_FORM, draftOfForm, formOfRow, type McpForm } from "./mcpForm";
import { mcpFormVerdicts } from "./mcpFormVerdicts";
import { buildMcpGroups, type GroupWorkspace, type McpNavGroup } from "./mcpGroups";
import { mcpRowAt, sameMcpEditorScope, type McpEditorScope, type McpRow } from "./mcpRows";

export type McpConfirm = LibraryConfirm<McpScope>;

export interface McpEditorDeps {
  activeWs: GroupWorkspace | null;
  onClose(): void;
  canClose: boolean;
}

export function useMcpEditor({ activeWs, onClose, canClose }: McpEditorDeps) {
  const { servers, ...state } = useMcpLibrary(true);
  const tier = useBundledMcp();
  const bundled = useMemo(() => bundledMcpRows(tier), [tier]);
  // The machine's rows: the library's and the tier's, so a view selection
  // can be looked up the same way an edit one is. `null` stays null — the
  // tier's presence must not read as "the library loaded".
  const rows = useMemo<McpRow[] | null>(
    () => (servers === null ? null : [...servers, ...bundled]),
    [servers, bundled],
  );

  const editor = useLibraryEditor<
    McpEditorScope,
    McpScope,
    McpRow,
    McpForm,
    McpServerDraft,
    ReturnType<typeof mcpFormVerdicts>
  >({
    state: { rows, ...state },
    emptyForm: EMPTY_MCP_FORM,
    formOf: formOfRow,
    draftOf: draftOfForm,
    rowAt: mcpRowAt,
    // The bundled tier is read-only: its rows open the view panel.
    writeScopeOf: (row) => (row.scope.kind === "bundled" ? null : row.scope),
    viewRowAt: (all, name) => mcpRowAt(all, { kind: "bundled" }, name),
    sameRef: (a, b) => a.name === b.name && sameMcpEditorScope(a.scope, b.scope),
    verdicts: mcpFormVerdicts,
    onClose,
    canClose,
  });

  const groups = useMemo<McpNavGroup[]>(
    () => buildMcpGroups(servers, activeWs, bundled),
    // On the FIELDS, not the object: `activeWs` is a fresh literal per App
    // render, and depending on its identity would rebuild the groups constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [servers, bundled, activeWs?.id, activeWs?.name],
  );

  const { rows: _rows, ...machine } = editor;
  return { ...machine, servers, groups };
}
