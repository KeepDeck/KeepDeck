import type { MarkRect } from "../domain/deck";

/** The column's workspace groups (each a reorder item, tagged `data-ws-id`),
 * in deck order — the ONE way the strip's code finds them. */
export function markGroups(listEl: HTMLElement | null): HTMLElement[] {
  return listEl ? [...listEl.querySelectorAll<HTMLElement>("[data-ws-id]")] : [];
}

/** Read each mark's vertical extent from the DOM, in document order —
 * the impure feed for the pure `markAtY` hit-test, split exactly like
 * `app/dragDrop.ts` / `domain/deck`. Items are tagged with `data-ws-id`. */
export function collectMarkRects(listEl: HTMLElement): MarkRect[] {
  const listTop = listEl.getBoundingClientRect().top;
  return markGroups(listEl).map((el) => {
    // Use layout geometry, not getBoundingClientRect(), because live FLIP reorder
    // animations transform the items visually. Hit-testing against transformed
    // rects makes targets slide under the pointer while the drag is still active.
    const top = listTop + el.offsetTop - listEl.scrollTop;
    return { id: el.dataset.wsId ?? "", top, bottom: top + el.offsetHeight };
  });
}
