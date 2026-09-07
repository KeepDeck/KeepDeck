import type { ReactNode } from "react";
import { CloseButton } from "../../ui/CloseButton";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ModalOverlay } from "../../ui/ModalOverlay";
import type { LibraryConfirm } from "./useLibraryEditor";

/** What the shell reads off a library's machine — the same for every
 * library, which is why the shell exists. */
export interface LibraryShellMachine {
  /** The listed rows; `null` until the first read lands. */
  rows: readonly unknown[] | null;
  error: string | null;
  /** Whether anything is open — the panel or the placeholder. */
  selection: { mode: string } | null;
  confirm: LibraryConfirm<unknown> | null;
  /** Close, guarded by the machine's discard confirm. */
  navigate(next: null, closing: true): void;
  confirmDelete(): void;
  confirmDiscard(): void;
  cancelConfirm(): void;
}

interface LibraryDialogProps {
  /** The heading, and the dialog's accessible name: "Skills", "MCP servers". */
  title: string;
  /** The close button's accessible name: "Close skills". */
  closeLabel: string;
  /** How one item reads in a sentence: "skill", "server" — the confirms
   * are composed from it. */
  noun: string;
  /** What the placeholder says when nothing is open and the library read. */
  placeholder: { title: string; body: string };
  machine: LibraryShellMachine;
  /** A notice above the body — where skills were refused, for one. */
  banner?: ReactNode;
  nav: ReactNode;
  /** The panel for the open selection. Rendered only while one is open. */
  editor: ReactNode;
}

/**
 * The library dialog's SHELL: the chrome, the placeholder's three states
 * (loading, a library that could not be read, nothing open), and the two
 * confirms — everything a library dialog has that does not depend on what
 * its items are. Decides nothing: the machine owns every transition, and
 * the library hands in its own nav and editor.
 *
 * A library that could not be READ renders as an empty one, and with
 * nothing selected the editor — the only other place an error appears — is
 * not mounted; the placeholder is where that error has to show, or the
 * dialog claims the user simply has nothing.
 */
export function LibraryDialog({
  title,
  closeLabel,
  noun,
  placeholder,
  machine,
  banner,
  nav,
  editor,
}: LibraryDialogProps) {
  const { rows, error, selection, confirm } = machine;
  return (
    <ModalOverlay>
      <div className="form library" role="dialog" aria-modal="true" aria-label={title}>
        <div className="settings__head">
          <h2 className="form__title settings__title">{title}</h2>
          <CloseButton label={closeLabel} onClick={() => machine.navigate(null, true)} />
        </div>

        {banner}

        <div className="library__body">
          {nav}
          <section className="library__editor">
            {selection === null ? (
              <div className="library__placeholder">
                {rows === null ? (
                  "Loading…"
                ) : error !== null ? (
                  <span className="library__placeholder-title kd-selectable" role="alert">
                    {error}
                  </span>
                ) : (
                  <>
                    <span className="library__placeholder-title">{placeholder.title}</span>
                    <span>{placeholder.body}</span>
                  </>
                )}
              </div>
            ) : (
              editor
            )}
          </section>
        </div>
      </div>

      {confirm?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete ${noun}`}
          message={`Delete "${confirm.name}"? Agents lose it on their next session`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          destructive
          onConfirm={machine.confirmDelete}
          onCancel={machine.cancelConfirm}
        />
      )}
      {confirm?.kind === "discard" && (
        <ConfirmDialog
          title="Discard changes"
          message={`This ${noun} has unsaved changes`}
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={machine.confirmDiscard}
          onCancel={machine.cancelConfirm}
        />
      )}
    </ModalOverlay>
  );
}
