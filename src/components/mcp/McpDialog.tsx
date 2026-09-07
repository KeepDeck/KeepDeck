import { LibraryDialog } from "../library/LibraryDialog";
import { LibraryNav } from "../library/LibraryNav";
import { McpEditor } from "./McpEditor";
import { BUNDLED_NOTICE, BUNDLED_PENDING } from "./bundledTier";
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

/**
 * The MCP-server library manager — a full-screen editor over the library
 * ([mcp]): one server defined here reaches every CLI at its next spawn.
 *
 * The servers HALF of the shell: the nav under the servers copy and the
 * editor's fields. Every transition belongs to `useMcpEditor`; the chrome,
 * the placeholder and the confirms are the shared [`LibraryDialog`]'s. The
 * panels stay CONTROLLED: the machine owns every transition, so this file
 * decides nothing.
 */
export function McpDialog({ activeWs, onClose, canClose = true }: McpDialogProps) {
  const editor = useMcpEditor({ activeWs, onClose, canClose });
  const { error, groups, selection, form, verdicts, busy } = editor;

  return (
    <LibraryDialog
      title="MCP servers"
      closeLabel="Close MCP servers"
      noun="server"
      placeholder={{
        title: "One server, every agent",
        body: "Pick a server on the left or create one — it reaches Claude Code, Kimi, OpenCode and Codex panes at their next session",
      }}
      machine={{ ...editor, rows: editor.servers }}
      nav={
        <LibraryNav
          groups={groups}
          copy={MCP_NAV_COPY}
          emptyMeans={editor.emptyMeans}
          busy={editor.deletingNow}
          isActive={editor.isActive}
          onOpen={(row) => editor.navigate(editor.selectionFor(row))}
          onCreate={(scope) => editor.navigate({ mode: "create", scope })}
        />
      }
      editor={
        selection && (
          <McpEditor
            creating={editor.creating}
            savedName={selection.mode === "create" ? null : selection.name}
            scopeLabel={labelForMcpScope(
              groups,
              selection.mode === "view" ? { kind: "bundled" } : selection.scope,
            )}
            readOnly={verdicts.isView}
            readOnlyNotice={verdicts.isView ? BUNDLED_NOTICE : undefined}
            readOnlyHint={editor.viewRow?.verdict.kind === "pending" ? BUNDLED_PENDING : undefined}
            repairing={verdicts.repairReason}
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
        )
      }
    />
  );
}
