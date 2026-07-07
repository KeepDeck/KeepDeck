import type { Terminal } from "@xterm/xterm";
import {
  detectLinks,
  openErrorHint,
  resolvePathTarget,
  type DetectedLink,
} from "./links";
import { logicalLineAt, mapRange, type BufferRange } from "./wrappedLines";
import type { PaneHint } from "./PaneHint";

/**
 * Where link activation lands: cwd for relative paths, hints for feedback, and
 * — INVERTED for the kit — the open primitives themselves. The provider owns
 * no ipc: a consumer injects `openUrl`/`openPath` (the host binds its Tauri
 * ipc; a test hands in `vi.fn()`s), so the kit stays transport-agnostic and
 * bundles cleanly into any consumer.
 */
export interface TerminalLinkTarget {
  /** Working dir resolving relative path links; null resolves against the
   * app's cwd (the backend's default). */
  cwd: string | null;
  /** Transient in-surface feedback (the ⌘ affordance, a failed open),
   * anchored at surface-local coordinates. */
  showHint(hint: PaneHint): void;
  /** Open a URL in the user's default browser ([F14]). */
  openUrl(url: string): Promise<void>;
  /** Open a file path in its default app ([F10]). */
  openPath(path: string): Promise<void>;
}

/**
 * Cells of slack on each side of a link's hit region. The pointer→cell math
 * (floor of pixel / renderer cell width) plus the canvas renderer's sub-pixel
 * glyph placement make the link's LEFT-edge cell the easiest to miss — clicking
 * the right half "just works", the leftmost char often doesn't. One cell of
 * tolerance forgives that; the padded neighbour opens the same link anyway.
 */
const HIT_PAD = 1;

/**
 * The 1-based buffer cell under a mouse event, from PUBLIC geometry — the
 * `.xterm-screen` rect divided by the grid — so we don't reach into xterm's
 * private mouse service. `row` is a 0-based ABSOLUTE buffer line (scroll
 * included), matching `logicalLineAt`'s coordinate; `col` is 1-based like
 * `ILink.range`. Null when the grid isn't measurable or the point is off-grid.
 */
function cellFromEvent(
  term: Terminal,
  event: MouseEvent,
): { col: number; row: number } | null {
  const screen = term.element?.querySelector(".xterm-screen");
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  const cellW = rect.width / term.cols;
  const cellH = rect.height / term.rows;
  if (!(cellW > 0) || !(cellH > 0)) return null;

  const col = Math.floor((event.clientX - rect.left) / cellW) + 1;
  const viewportRow = Math.floor((event.clientY - rect.top) / cellH);
  if (col < 1 || col > term.cols || viewportRow < 0 || viewportRow >= term.rows) {
    return null;
  }
  return { col, row: viewportRow + term.buffer.active.viewportY };
}

/** Does `range` cover 1-based buffer cell (col,row), with `pad` cells of slack
 *  at the link's own ends? A multi-row link covers whole interior rows. */
function covers(range: BufferRange, col: number, row: number, pad: number): boolean {
  if (row < range.start.y || row > range.end.y) return false;
  const afterStart = row > range.start.y || col >= range.start.x - pad;
  const beforeEnd = row < range.end.y || col <= range.end.x + pad;
  return afterStart && beforeEnd;
}

/** The detected link under cell (col,row): an exact hit wins over a padded one,
 *  so slack never steals a click from an adjacent link. */
function linkAtCell(
  links: { link: DetectedLink; range: BufferRange }[],
  col: number,
  row: number,
): { link: DetectedLink; range: BufferRange } | null {
  return (
    links.find((l) => covers(l.range, col, row, 0)) ??
    links.find((l) => covers(l.range, col, row, HIT_PAD)) ??
    null
  );
}

/** Open a detected link (or, without ⌘, show the affordance) and surface a
 *  failed open next to the click. Shared by the raw ⌘-click handler and the
 *  xterm provider's own activate, so both paths behave identically. */
function openOrHint(
  d: DetectedLink,
  event: MouseEvent,
  host: HTMLElement,
  target: TerminalLinkTarget,
): void {
  // Surface-local coords captured now, at click-time geometry, not when a
  // rejection lands later.
  const rect = host.getBoundingClientRect();
  const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  // The ⌘ affordance is undiscoverable — answer a plain (or wrong-modifier)
  // click on a link with how to open it ([U8]).
  if (!event.metaKey) {
    target.showHint({ text: "⌘-click to open", ...at });
    return;
  }
  const dest =
    d.kind === "url" ? d.text : resolvePathTarget(d.text, target.cwd ?? "");
  const open = d.kind === "url" ? target.openUrl(dest) : target.openPath(dest);
  // Surface the failure — a deleted file, a bad URL — next to the link that
  // was clicked instead of swallowing it ([F16]).
  open.catch((err: unknown) =>
    target.showHint({ text: openErrorHint(err, dest), ...at }),
  );
}

/**
 * Cmd+click a URL or file path in the output to open it ([F14]/[F10]) —
 * shared by every xterm surface (agent panes, the Run log); plain click is
 * left for text selection (a plain click ON a link shows the ⌘ hint, [U8]).
 * Relative paths resolve against the surface's cwd; the OS default app opens
 * files / the default browser opens URLs. Detection runs on the whole LOGICAL
 * line — the requested row joined with its wrapped neighbours — so a link the
 * terminal wrapped is still one link, not per-row fragments.
 *
 * Opening does NOT go through xterm's own link activation. xterm only fires a
 * link's `activate` when the SAME link stayed hover-armed continuously from
 * mousedown to mouseup (`_mouseDownLink === _currentLink`), and that arming is
 * cleared by every buffer write — so on a streaming agent pane a ⌘-click keeps
 * missing until the writes pause. Instead a capture-phase ⌘-mousedown resolves
 * the cell itself and opens the link there and then, arming-independent. The
 * xterm provider is kept only for the hover underline; its `activate` is a
 * fallback for the (rare) case our geometry can't be measured, deduped so a
 * gesture never opens twice.
 *
 * `host` anchors hint coordinates: the element xterm is mounted in, whose
 * offset parent renders the PaneHintView.
 */
export function registerTerminalLinks(
  term: Terminal,
  host: HTMLElement,
  target: TerminalLinkTarget,
): { dispose(): void } {
  // Set when our own ⌘-mousedown handled the gesture, so xterm's later
  // mouseup-driven activate skips it (belt-and-suspenders with stopPropagation).
  let handledByUs = false;

  const onMouseDown = (event: MouseEvent) => {
    handledByUs = false;
    // Plain clicks stay with the provider (the ⌘ hint) and text selection.
    if (!event.metaKey) return;
    const cell = cellFromEvent(term, event);
    if (!cell) return; // geometry unavailable → let the provider's activate try
    const logical = logicalLineAt(term.buffer.active, cell.row, term.cols);
    if (!logical) return;
    const ranged = detectLinks(logical.rows.join("")).map((link) => ({
      link,
      range: mapRange(logical, link.start, link.end),
    }));
    const hit = linkAtCell(ranged, cell.col, cell.row + 1);
    if (!hit) return;
    // Ours: don't let xterm start a selection or arm/fire its own activate.
    event.preventDefault();
    event.stopPropagation();
    handledByUs = true;
    openOrHint(hit.link, event, host, target);
  };
  host.addEventListener("mousedown", onMouseDown, true);

  const provider = term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const logical = logicalLineAt(term.buffer.active, lineNumber - 1, term.cols);
      const found = logical ? detectLinks(logical.rows.join("")) : [];
      callback(
        found.length === 0 || !logical
          ? undefined
          : found.map((d) => ({
              text: d.text,
              range: mapRange(logical, d.start, d.end),
              activate(event: MouseEvent) {
                // Our ⌘-mousedown already opened this gesture — don't double it.
                if (handledByUs) {
                  handledByUs = false;
                  return;
                }
                openOrHint(d, event, host, target);
              },
            })),
      );
    },
  });

  return {
    dispose() {
      host.removeEventListener("mousedown", onMouseDown, true);
      provider.dispose();
    },
  };
}
