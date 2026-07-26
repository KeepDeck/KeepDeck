import { useLayoutEffect, useRef, type ReactNode } from "react";

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
 *
 * The body is the overlay's ONE scroll container, and it survives a change of
 * content — consumers swap what's inside without remounting it. That makes
 * scroll position and focus the shell's to manage rather than each consumer's;
 * `scrollKey` carries the rule.
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
  /** An optional right-hand rail beside the body — a sibling list, an
   * outline. Scrolls on its own; the body's scrolling is untouched. */
  aside?: ReactNode;
  /** Identity of what the body is showing — a path, a revision-qualified file
   * key. A CHANGE returns the body to the top and takes focus back, so the
   * next thing starts at its first line with the keys that scroll it aimed at
   * it. Re-renders under the same key (a load step landing, a watcher refresh
   * re-reading the same content) leave the reader's position alone, so this
   * must encode only *which* thing is on screen — never how far along its
   * load it is.
   *
   * Required on purpose: the body outlives its content, so every consumer has
   * to answer this. Two files that render an identical header are still two
   * different things — key off what you fetched, not what you display. */
  scrollKey: string;
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
  aside,
  scrollKey,
  onClose,
  children,
}: PeekProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // New content, fresh viewport — and the keys that scroll it aimed back at
  // it. Both axes: the body scrolls horizontally too (a diff is sized to its
  // widest line), and a long line's offset carries over just the same.
  // Explicit rather than left to the browser's clamping of a shrinking
  // placeholder — that only resets when the swap happens to straddle a layout,
  // which is a race, not a behavior. Layout effect, so it lands before paint:
  // the old content is still mounted here, and the reader never sees the
  // position move.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = 0;
    body.scrollLeft = 0;
    // Focus tracks the content, not just the mount. The body is what
    // PageUp/PageDown scroll, and on engines where clicking a control focuses
    // it — an `aside` rail's rows are usually real buttons — a mount-only
    // focus would hand it away on the first click and never take it back.
    // `preventScroll` so restoring it cannot undo the reset above.
    body.focus({ preventScroll: true });
  }, [scrollKey]);

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
        <div className="peek__main">
          <div className="peek__body" ref={bodyRef} tabIndex={0}>
            {children}
          </div>
          {aside != null && <aside className="peek__aside">{aside}</aside>}
        </div>
      </div>
    </div>
  );
}
