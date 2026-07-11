import { useEffect, useRef, type ReactNode } from "react";

/**
 * The wide "peek" overlay — a dock plugin's detail surface. A 340px rail can't
 * read code or a diff, so opening a detail lifts it OUT of the panel into a
 * centered surface over the whole window (a `position: fixed` backdrop — no
 * ancestor establishes a transform/stacking trap, so it reaches the viewport
 * without a portal; matches the host's own `.modal-overlay`). Dismiss with
 * Esc, the back button, or a click on the dimmed backdrop.
 *
 * This is the SHELL only — backdrop, panel, header, the focusable scroll body.
 * What fills it (a file preview, a diff) is the consumer's, as are any header
 * `actions` (styled `.peek__act`, `.peek__act--on` when toggled on) and the
 * optional `path` line under the header. Styles live in the host stylesheet
 * (`peek.css`), per the builtin-tier rule.
 */
export interface PeekProps {
  /** Accessible name for the dialog. */
  ariaLabel: string;
  /** The bold header title — usually a file name. */
  name: string;
  /** Small muted facts right of the name (a size, a status badge). */
  meta?: ReactNode;
  /** Header action buttons, rendered after the meta. */
  actions?: ReactNode;
  /** The second header line — a breadcrumb, a rename trail. Omitted = no line. */
  path?: ReactNode;
  onClose: () => void;
  /** The scrollable body content. */
  children: ReactNode;
}

export function Peek({
  ariaLabel,
  name,
  meta,
  actions,
  path,
  onClose,
  children,
}: PeekProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Focus the scroll body so arrow keys scroll the content; Esc closes from
  // anywhere inside via the backdrop handler below.
  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  return (
    <div
      className="peek"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div
        className="peek__panel"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        // A click inside the panel must not fall through to the backdrop.
        onClick={(event) => event.stopPropagation()}
      >
        <div className="peek__head">
          <button
            type="button"
            className="peek__back"
            onClick={onClose}
            title="Back (Esc)"
            aria-label="Close the detail view"
          >
            <svg
              viewBox="0 0 24 24"
              width={13}
              height={13}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="peek__name" title={name}>
            {name}
          </span>
          {meta}
          {actions}
        </div>
        {path != null && path !== "" && <div className="peek__path">{path}</div>}
        <div className="peek__body" ref={bodyRef} tabIndex={0}>
          {children}
        </div>
      </div>
    </div>
  );
}
