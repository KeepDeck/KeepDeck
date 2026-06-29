import { useEscape } from "./useEscape";
import { DestructiveButton } from "./DestructiveButton";

interface ConfirmDialogProps {
  title: string;
  /** Body text; `\n` renders as line breaks (white-space: pre-line). */
  message: string;
  /** Confirm button label (default "OK"). */
  confirmLabel?: string;
  /** Cancel button label; the cancel button shows only when this is set. */
  cancelLabel?: string;
  /** Style the confirm button as destructive (red) for irreversible actions,
   * and default focus to Cancel so Enter/Esc don't trigger it. */
  destructive?: boolean;
  onConfirm(): void;
  onCancel?(): void;
}

/**
 * In-app modal for confirmations and error messages — used instead of the
 * native/browser confirm()/alert(), which don't render in the Tauri webview
 * and look out of place. With only `confirmLabel` it's a one-button notice;
 * add `cancelLabel` + `onCancel` for a yes/no prompt. In a yes/no prompt the
 * Cancel button takes focus (Enter cancels); a one-button notice focuses its
 * single button.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "OK",
  cancelLabel,
  destructive,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Esc cancels a yes/no prompt, or dismisses a one-button notice.
  useEscape(onCancel ?? onConfirm);
  const hasCancel = Boolean(cancelLabel && onCancel);

  return (
    <div className="modal-overlay">
      <div className="confirm" role="dialog" aria-modal="true">
        <h2 className="confirm__title">{title}</h2>
        <p className="confirm__message">{message}</p>
        <div className="confirm__actions">
          {hasCancel && (
            <button
              type="button"
              className="form__cancel"
              onClick={onCancel}
              autoFocus
            >
              {cancelLabel}
            </button>
          )}
          {destructive ? (
            <DestructiveButton onClick={onConfirm} autoFocus={!hasCancel}>
              {confirmLabel}
            </DestructiveButton>
          ) : (
            <button
              type="button"
              className="form__create"
              onClick={onConfirm}
              autoFocus={!hasCancel}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
