import { type ReactNode } from "react";
import { useEscape, useHeldEnterGuard } from "./useEscape";
import { DestructiveButton } from "./DestructiveButton";
import { ModalOverlay } from "./ModalOverlay";

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
  /** Extra content between the message and the actions (e.g. an opt-in
   * checkbox); optional so plain confirm/notice dialogs stay unchanged. */
  children?: ReactNode;
  /** A third, softer action beside cancel and confirm — the alternative worth
   * offering at the moment of the decision ("suspend instead of closing").
   * Rendered as an ordinary button between the two, so the destructive
   * confirm keeps its position and its weight. A disabled one states `hint`
   * as its tooltip: an action that silently does nothing reads as broken. */
  secondaryAction?: {
    label: string;
    disabled?: boolean;
    hint?: string;
    onClick(): void;
  };
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
  children,
  secondaryAction,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Esc cancels a yes/no prompt, or dismisses a one-button notice.
  useEscape(onCancel ?? onConfirm);
  // The dialog auto-focuses a button, so it INVITES a held Enter — and a hold
  // that outlives one dialog would run the next one's button too, which is how
  // a queue of notices gets dismissed unread.
  useHeldEnterGuard();
  const hasCancel = Boolean(cancelLabel && onCancel);

  return (
    <ModalOverlay>
      <div className="confirm" role="dialog" aria-modal="true">
        <h2 className="confirm__title">{title}</h2>
        <p className="confirm__message">{message}</p>
        {children}
        {/* A disabled action explains itself in TEXT, not in a `title`: the
            shipping runtimes suppress pointer events on disabled controls, so
            a tooltip there is never shown — which is the "reads as broken"
            outcome this hint exists to prevent. */}
        {secondaryAction?.disabled && secondaryAction.hint && (
          <p className="confirm__hint">{secondaryAction.hint}</p>
        )}
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
          {secondaryAction && (
            <button
              type="button"
              className="form__cancel"
              onClick={secondaryAction.onClick}
              disabled={secondaryAction.disabled}
            >
              {secondaryAction.label}
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
    </ModalOverlay>
  );
}
