/** Pure hit-test geometry for dropping files onto the pane grid — the pane
 * half of what `railDnd.ts` does for the workspaces rail. The DOM read feeding
 * it lives in `app/dragDrop.ts`. */

/** A rectangle in viewport CSS pixels. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PaneRect {
  id: string;
  rect: Rect;
}

/**
 * What a drop point can land on, in ONE value so both halves are read from the
 * same layout: the panes that can receive it, and the chrome lying over them.
 *
 * `blockers` exists because the dock can float (settings → Dock): it covers
 * panes instead of taking a column beside them, and a rect the user cannot see
 * through must not pass a drop to the pane underneath it. Docked, the list is
 * empty and the hit-test is exactly what it always was.
 */
export interface DropSurface {
  panes: PaneRect[];
  blockers: Rect[];
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

/**
 * The id of the pane at the point (viewport CSS pixels), or null — for a point
 * over no pane, and for one over chrome that covers a pane. Panes don't
 * overlap, so the first containing rect wins. Pure (the surface is passed in)
 * so the geometry is testable without real layout — the only un-coverable
 * piece is reading it (`app/dragDrop.collectDropSurface`).
 */
export function paneAtPoint(
  x: number,
  y: number,
  surface: DropSurface,
): string | null {
  if (surface.blockers.some((rect) => contains(rect, x, y))) return null;
  for (const { id, rect } of surface.panes) {
    if (contains(rect, x, y)) return id;
  }
  return null;
}
