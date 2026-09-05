import type { ReactNode } from "react";
import { DestructiveButton } from "../../ui/DestructiveButton";
import { Chip } from "../../ui/Chip";

interface EditorFrameProps {
  /** Create mode titles the frame with `newTitle` and offers Create; edit
   * mode titles it with the saved name and offers Delete. */
  creating: boolean;
  newTitle: string;
  /** The saved name an edit is anchored to. */
  savedName: string | null;
  scopeLabel: string;
  /** A read-only row uses the same frame without any write control. */
  readOnly?: boolean;
  /** Guidance for a read-only row, kept outside the fields. */
  readOnlyNotice?: string;
  dirty: boolean;
  /** The item was removed or renamed elsewhere while it was open — the
   * library's own sentence about it. */
  vanishedMessage: string | null;
  /** Backend text, not authored copy — selectable so it can be copied into
   * a bug report. */
  error: string | null;
  canSave: boolean;
  /** A write is in flight. Both buttons go quiet — a delete racing a save can
   * re-create the item the user just confirmed deleting, and the guard has to
   * be visible rather than silently swallowing the click. */
  busy: boolean;
  onSubmit(): void;
  onDelete(): void;
  /** The library's own fields. */
  children: ReactNode;
}

/** The chrome every library editor shares — the heading with its dirty dot
 * and scope chip, the notices, and the Delete / Save row — around the fields
 * only that library knows. A CONTROLLED frame: the machine owns every
 * decision, this renders it. */
export function EditorFrame({
  creating,
  newTitle,
  savedName,
  scopeLabel,
  readOnly = false,
  readOnlyNotice,
  dirty,
  vanishedMessage,
  error,
  canSave,
  busy,
  onSubmit,
  onDelete,
  children,
}: EditorFrameProps) {
  return (
    <>
      {readOnlyNotice && <p className="library__readonly-note">{readOnlyNotice}</p>}
      <div className="library__editor-head">
        <h3 className="library__editor-title">
          {creating ? newTitle : savedName}
          {!readOnly && dirty && (
            <span className="library__dirty" title="Unsaved changes" aria-label="Unsaved changes" />
          )}
        </h3>
        <Chip size="inline" className="library__scope" label={scopeLabel} />
      </div>

      {children}

      {!readOnly && vanishedMessage && (
        <div className="form__error">{vanishedMessage}</div>
      )}
      {!readOnly && error && <div className="form__error kd-selectable">{error}</div>}
      {!readOnly && (
        <div className="library__actions">
          {!creating && (
            <DestructiveButton onClick={onDelete} disabled={busy}>
              Delete
            </DestructiveButton>
          )}
          <span className="library__actions-gap" />
          <button
            type="button"
            className="form__create"
            onClick={onSubmit}
            disabled={!canSave || busy}
          >
            {creating ? "Create" : "Save"}
          </button>
        </div>
      )}
    </>
  );
}
