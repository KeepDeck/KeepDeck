/** Pure hit-test geometry for dropping files onto the pane grid — the pane
 * half of what `railDnd.ts` does for the workspaces rail. The DOM read feeding
 * it lives in `app/dragDrop.ts`. */

export interface PaneRect {
  id: string;
  rect: { left: number; top: number; right: number; bottom: number };
}

/**
 * The id of the pane whose rect contains the point (viewport CSS pixels), or
 * null. Panes don't overlap, so the first containing rect wins. Pure (rects are
 * passed in) so the hit-test geometry is testable without real layout — the only
 * un-coverable piece is reading the live rects (`app/dragDrop.collectPaneRects`).
 */
export function paneAtPoint(
  x: number,
  y: number,
  rects: PaneRect[],
): string | null {
  for (const { id, rect } of rects) {
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
      return id;
    }
  }
  return null;
}
