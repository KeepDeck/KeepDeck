import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type Ref,
} from "react";
import { dropBlocker } from "./dropBlocker.ts";
import { coverWindow } from "./windowCover.ts";

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
 * content — consumers swap what's inside without remounting it. So the shell
 * owns where a CHANGE of content leaves the reader: `scrollKey` carries that
 * rule. A consumer that re-lays-out the SAME content — wrapping lines, say —
 * keeps its own place across it, and takes `bodyRef` to measure against rather
 * than guessing at this element from a child.
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
  /** Identity of what the body is showing. A CHANGE returns it to the top and
   * takes focus back; re-renders under the same key (a load step landing, a
   * watcher refresh) leave the reader's position alone. So this must encode
   * only WHICH thing is on screen, never how far along its load it is, and it
   * must come from what the consumer fetched rather than what it displays —
   * two things can render an identical header. Required: the body outlives its
   * content, so every consumer has to answer for it. */
  scrollKey: string;
  /** Optional access to the scroll body, for a consumer that must measure
   * against the viewport its content sits in — the alternative is walking up
   * from a child and silently guessing this element's identity. */
  bodyRef?: Ref<HTMLDivElement>;
  onClose: () => void;
  /** The scrollable body content. */
  children: ReactNode;
}

/** Keys that mean "scroll the content" but that the header's controls cannot
 * act on — the header sits OUTSIDE the scroll body, so once focus is on a
 * button there the browser has no scrollable ancestor to hand them to. */
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End"]);

/** Is this the header — the one region whose focus the shell leaves alone? */
function inHeader(node: EventTarget | null): boolean {
  return node instanceof Element && node.closest(".peek__head") !== null;
}

export function Peek({
  ariaLabel,
  name,
  meta,
  actions,
  path,
  aside,
  scrollKey,
  bodyRef: exposedBodyRef,
  onClose,
  children,
}: PeekProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const attachBody = (node: HTMLDivElement | null) => {
    bodyRef.current = node;
    if (typeof exposedBodyRef === "function") exposedBodyRef(node);
    else if (exposedBodyRef) exposedBodyRef.current = node;
  };

  // New content, fresh viewport — and the keys that scroll it aimed back at
  // it. Both axes: the body scrolls horizontally too (a diff is sized to its
  // widest line), and a long line's offset carries over just the same.
  // Explicit rather than left to the browser's clamping of a shrinking
  // placeholder — that only resets when the swap happens to straddle a layout,
  // which is a race, not a behavior. Layout effect, so it lands before paint:
  // the old content is still mounted here, and the reader never sees the
  // position move.
  // Say that the window is covered for as long as this is up. The host's
  // "is anything in front of the deck?" rules — which hotkeys may fire, and
  // whether a pane is visible enough to skip its notification banner — cannot
  // see a surface a plugin opened inside a resident overlay.
  useEffect(() => coverWindow(), []);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = 0;
    body.scrollLeft = 0;
    // Focus tracks the content, not just the mount: on engines where clicking
    // a control focuses it, an `aside` rail's rows are real buttons, and a
    // mount-only focus would hand the scroll keys away on the first click and
    // never take them back. The header is the exception — its controls are
    // toggles the reader may want to press again, so taking focus off one the
    // moment it changes the content would make it unrepeatable. Chrome keeps
    // its focus and borrows the scroll keys instead, below.
    // `preventScroll` so restoring focus cannot undo the reset above.
    if (!inHeader(document.activeElement)) body.focus({ preventScroll: true });
  }, [scrollKey]);

  return (
    <div
      className="peek"
      // It covers the window, so a file dropped on it is the peek's — an OS
      // drop is routed by coordinates alone and would otherwise be typed into
      // whatever pane happens to lie behind the panel.
      {...dropBlocker()}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        // A header control holds focus after being activated, and the header
        // is not inside the scroll body — so these keys would reach nothing
        // at all. Hand them to the body rather than the focus back to it.
        const body = bodyRef.current;
        if (!body || !SCROLL_KEYS.has(event.key)) return;
        if (!inHeader(event.target)) return;
        event.preventDefault();
        // A page keeps a couple of lines of overlap, the way a browser's own
        // paging does, so the reader has something to re-anchor on.
        const page = body.clientHeight * 0.9;
        if (event.key === "PageDown") body.scrollTop += page;
        else if (event.key === "PageUp") body.scrollTop -= page;
        else if (event.key === "Home") body.scrollTop = 0;
        else body.scrollTop = body.scrollHeight;
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
          <div className="peek__body" ref={attachBody} tabIndex={0}>
            {children}
          </div>
          {aside != null && <aside className="peek__aside">{aside}</aside>}
        </div>
      </div>
    </div>
  );
}
