/** Pure hit-test geometry for drag-reordering the workspaces rail — mirrors
 * `domain/dnd.ts`. The DOM read feeding it lives in `app/railDnd.ts`, exactly
 * as `app/dragDrop.ts` feeds the pane hit-test, so this module needs no DOM
 * to test. */

export interface RailItemRect {
  id: string;
  top: number;
  bottom: number;
}

/**
 * The id of the rail item whose vertical span contains `y`. The list is a
 * single column, so only the Y axis matters. Above the first item resolves to
 * the first; below the last resolves to the last — a drag that runs off either
 * end still targets the nearest slot. `null` only when there are no items.
 */
export function railItemAtY(y: number, rects: RailItemRect[]): string | null {
  if (rects.length === 0) return null;
  for (const r of rects) {
    if (y < r.bottom) return r.id; // first item whose bottom is past the cursor
  }
  return rects[rects.length - 1].id; // below everything → the last item
}

