/** Geometry helpers for drag-reordering the workspaces rail. Kept pure (and the
 * DOM read isolated) so the long-press/pointer wiring in `WorkspacesRail` stays
 * thin and the hit-test is unit-testable — mirrors `terminal/dnd.ts`. */

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

/** Read each rail item's vertical extent from the DOM, in document order. Items
 * are tagged with `data-ws-id`. */
export function collectRailItemRects(listEl: HTMLElement): RailItemRect[] {
  return [...listEl.querySelectorAll<HTMLElement>("[data-ws-id]")].map((el) => {
    const rect = el.getBoundingClientRect();
    return { id: el.dataset.wsId ?? "", top: rect.top, bottom: rect.bottom };
  });
}
