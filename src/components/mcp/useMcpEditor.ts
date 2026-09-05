/**
 * The server editor: the generic library machine ([`useLibraryEditor`])
 * configured for MCP servers — the form is text the draft is built from, a
 * bundled row opens the read-only panel — plus the derived facts only this
 * shell needs: the nav's groups and the bundled tier's readiness.
 *
 * The bundled tier is presented THROUGH the machine (a view selection) but
 * is not a library: the state the machine writes to narrows every write back
 * to a library scope, and a bundled scope reaching one is a programming
 * error, thrown loudly — the nav offers the tier no "+ New" and a view
 * selection never writes, so the narrowing is the backstop, not the door.
 */
import { useMemo } from "react";
import type { LibraryState } from "../../app/useLibraryState";
import { useMcpLibrary } from "../../app/useMcpLibrary";
import { useMcpStatus } from "../../app/mcp/useMcpStatus";
import type { McpScope, McpServerDraft } from "../../domain/mcp";
import { useLibraryEditor, type LibraryConfirm } from "../library/useLibraryEditor";
import {
  EMPTY_MCP_FORM,
  draftOfForm,
  formOfRow,
  type McpEditorScope,
  type McpForm,
  type McpRow,
} from "./mcpForm";
import { mcpFormVerdicts, mcpRowAt, sameMcpEditorScope } from "./mcpFormVerdicts";
import { buildMcpGroups, bundledMcpRows, type GroupWorkspace, type McpNavGroup } from "./mcpGroups";

export type McpConfirm = LibraryConfirm<McpEditorScope>;

export interface McpEditorDeps {
  activeWs: GroupWorkspace | null;
  onClose(): void;
  canClose: boolean;
}

/** A dialog scope as the library takes it. The bundled tier has no library
 * to write to; a write reaching here with it is the machine's bug, not a
 * refusal to word for the user. */
function libraryScope(scope: McpEditorScope): McpScope {
  if (scope.kind === "bundled") {
    throw new Error("bundled servers ship with KeepDeck — the editor never writes one");
  }
  return scope;
}

export function useMcpEditor({ activeWs, onClose, canClose }: McpEditorDeps) {
  const { servers, ...state } = useMcpLibrary(true);
  const status = useMcpStatus();
  const bundled = useMemo(() => bundledMcpRows(status.connect), [status.connect]);
  // The machine's rows: the library's and the tier's, so a view selection
  // can be looked up the same way an edit one is. `null` stays null — the
  // tier's presence must not read as "the library loaded".
  const rows = useMemo<McpRow[] | null>(
    () => (servers === null ? null : [...servers, ...bundled]),
    [servers, bundled],
  );

  const machineState: LibraryState<McpEditorScope, McpRow, McpServerDraft> = {
    rows,
    error: state.error,
    listTrusted: state.listTrusted,
    clearError: state.clearError,
    save: (scope, draft, mode) => state.save(libraryScope(scope), draft, mode),
    rename: (scope, from, to) => state.rename(libraryScope(scope), from, to),
    remove: (scope, name) => state.remove(libraryScope(scope), name),
  };

  const editor = useLibraryEditor<
    McpEditorScope,
    McpRow,
    McpForm,
    McpServerDraft,
    ReturnType<typeof mcpFormVerdicts>
  >({
    state: machineState,
    emptyForm: EMPTY_MCP_FORM,
    formOf: formOfRow,
    draftOf: draftOfForm,
    rowAt: mcpRowAt,
    isViewRow: (row) => row.scope.kind === "bundled",
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
  return {
    ...machine,
    servers,
    groups,
    /** Whether the deck's own server has an invocation to show yet. */
    bundledReady: status.connect !== null,
  };
}
