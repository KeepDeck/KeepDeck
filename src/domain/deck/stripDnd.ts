/** Pure hit-test geometry for drag-reordering the workspace strip — mirrors
 * `paneDnd.ts`. The DOM read feeding it lives in `ui/stripDnd.ts`, exactly
 * as `app/dragDrop.ts` feeds the pane hit-test, so this module needs no DOM
 * to test. */

import type { WorkspacePlace } from "./workspaces";

export interface MarkRect {
  id: string;
  top: number;
  bottom: number;
}

/**
 * The id of the mark whose vertical span contains `y`. The list is a
 * single column, so only the Y axis matters. Above the first item resolves to
 * the first; below the last resolves to the last — a drag that runs off either
 * end still targets the nearest slot. `null` only when there are no items.
 */
export function markAtY(y: number, rects: MarkRect[]): string | null {
  if (rects.length === 0) return null;
  for (const r of rects) {
    if (y < r.bottom) return r.id; // first item whose bottom is past the cursor
  }
  return rects[rects.length - 1].id; // below everything → the last item
}

/**
 * Where a dragged mark lands when the pointer is over `overId`, in a column
 * drawn in `order`: a mark dragged DOWN onto another goes after it, one
 * dragged UP goes before it — so crossing a neighbour swaps the two either
 * way. Null when the pointer is over the dragged mark itself, or either id is
 * not in the column: nothing moves.
 */
export function dropPlace(
  order: readonly string[],
  draggedId: string,
  overId: string,
): WorkspacePlace | null {
  const from = order.indexOf(draggedId);
  const over = order.indexOf(overId);
  if (from < 0 || over < 0 || from === over) return null;
  return from < over ? { after: overId } : { before: overId };
}
