/**
 * Format dropped file paths for a pane's input, given (from the backend, by file
 * content — see `paths_are_images`) which ones are images. An image path is
 * wrapped in a bracketed paste (`ESC[200~ … ESC[201~`) so Claude Code recognises
 * it as a pasted file and attaches it; every other path (regular file or FOLDER)
 * is inserted RAW, because a bracketed non-image path is dropped on the floor by
 * Claude Code's paste handler. No shell quoting (the target is a text prompt, not
 * a shell — quoting corrupts the path); paths are space-joined.
 */
export function formatDroppedPaths(paths: string[], isImage: boolean[]): string {
  return paths
    .map((p, i) => (isImage[i] ? `\x1b[200~${p}\x1b[201~` : p))
    .join(" ");
}

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
