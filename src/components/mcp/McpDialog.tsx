import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { LibraryNav } from "../library/LibraryNav";
import { McpEditor } from "./McpEditor";
import { mcpRowAt, sameMcpEditorScope } from "./mcpFormVerdicts";
import { MCP_NAV_COPY, labelForMcpScope } from "./mcpGroups";
import { useMcpEditor } from "./useMcpEditor";

interface McpDialogProps {
  /** The active workspace, hosting the "This workspace" scope; `null` (no
   * workspace yet) leaves the global scope and the bundled tier. */
  activeWs: { id: string; name: string } | null;
  onClose(): void;
  /** False while a transaction is stacked over this dialog. */
  canClose?: boolean;
}

/** The bundled panel's standing framing: what the row is, and that it is
 * not the user's to edit. */
const BUNDLED_NOTICE =
  "Ships with KeepDeck and updates with it — every agent already has it. Read-only.";

/**
 * The MCP-server library manager — a full-screen editor over the library
 * ([mcp]): one server defined here reaches every CLI at its next spawn.
 *
 * The SHELL: chrome, the placeholder, and the panels. Every transition
 * belongs to `useMcpEditor`, and the panels stay CONTROLLED: the machine
 * owns every transition, so this file decides nothing.
 */
export function McpDialog({ activeWs, onClose, canClose = true }: McpDialogProps) {
  const editor = useMcpEditor({ activeWs, onClose, canClose });
  const { servers, error, listTrusted, groups, selection, form, verdicts, busy, deletingNow, confirm } =
    editor;

  // A file the codec could not read, open for repair: the machine hands the
  // editor the row's name alone, and the shell names the reason.
  const repairing =
    selection?.mode === "edit"
      ? (() => {
          const row = mcpRowAt(servers, selection.scope, selection.name);
          return row?.verdict.kind === "malformed" ? row.verdict.reason : null;
        })()
      : null;

  return (
    <ModalOverlay>
      <div className="form library" role="dialog" aria-modal="true" aria-label="MCP servers">
        <div className="settings__head">
          <h2 className="form__title settings__title">MCP servers</h2>
          <CloseButton label="Close MCP servers" onClick={() => editor.navigate(null, true)} />
        </div>

        <div className="library__body">
          <LibraryNav
            groups={groups}
            copy={MCP_NAV_COPY}
            emptyMeans={servers === null ? "loading" : listTrusted ? "empty" : "unknown"}
            busy={deletingNow}
            isActive={(row) =>
              (selection?.mode === "edit" &&
                selection.name === row.name &&
                sameMcpEditorScope(selection.scope, row.scope)) ||
              (selection?.mode === "view" &&
                row.scope.kind === "bundled" &&
                selection.name === row.name)
            }
            onOpen={(row) => editor.navigate(editor.selectionFor(row))}
            onCreate={(scope) => editor.navigate({ mode: "create", scope })}
          />

          <section className="library__editor">
            {selection === null ? (
              <div className="library__placeholder">
                {servers === null ? (
                  "Loading…"
                ) : error !== null ? (
                  <span className="library__placeholder-title kd-selectable" role="alert">
                    {error}
                  </span>
                ) : (
                  <>
                    <span className="library__placeholder-title">One server, every agent</span>
                    <span>
                      Pick a server on the left or create one — it reaches Claude Code, Kimi,
                      OpenCode and Codex panes at their next session
                    </span>
                  </>
                )}
              </div>
            ) : (
              <McpEditor
                creating={editor.creating}
                savedName={selection.mode === "create" ? null : selection.name}
                scopeLabel={
                  selection.mode === "view"
                    ? "Bundled"
                    : labelForMcpScope(groups, selection.scope)
                }
                readOnly={verdicts.isView}
                readOnlyNotice={verdicts.isView ? BUNDLED_NOTICE : undefined}
                readOnlyHint={
                  verdicts.isView && !editor.bundledReady
                    ? "The deck's socket is not up yet — the invocation fills in once it is."
                    : undefined
                }
                repairing={repairing}
                form={form}
                dirty={editor.dirty}
                validation={{
                  nameProblem: verdicts.shownNameProblem,
                  nameTaken: verdicts.nameTaken,
                  bodyProblem: verdicts.bodyProblem,
                  badLine: verdicts.badLine,
                  vanished: verdicts.vanished,
                }}
                canSave={verdicts.canSave}
                error={error}
                onField={editor.onField}
                onSubmit={() => void editor.submit()}
                busy={busy}
                onDelete={editor.requestDelete}
              />
            )}
          </section>
        </div>
      </div>

      {confirm?.kind === "delete" && (
        <ConfirmDialog
          title="Delete server"
          message={`Delete "${confirm.name}"? Agents lose it on their next session`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          destructive
          onConfirm={editor.confirmDelete}
          onCancel={editor.cancelConfirm}
        />
      )}
      {confirm?.kind === "discard" && (
        <ConfirmDialog
          title="Discard changes"
          message="This server has unsaved changes"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={editor.confirmDiscard}
          onCancel={editor.cancelConfirm}
        />
      )}
    </ModalOverlay>
  );
}
