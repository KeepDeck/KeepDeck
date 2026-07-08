import type { RailItemRect } from "../domain/deck";

/** Read each rail item's vertical extent from the DOM, in document order —
 * the impure feed for the pure `railItemAtY` hit-test, split exactly like
 * `app/dragDrop.ts` / `domain/deck`. Items are tagged with `data-ws-id`. */
export function collectRailItemRects(listEl: HTMLElement): RailItemRect[] {
  const listTop = listEl.getBoundingClientRect().top;
  return [...listEl.querySelectorAll<HTMLElement>("[data-ws-id]")].map((el) => {
    // Use layout geometry, not getBoundingClientRect(), because live FLIP reorder
    // animations transform the items visually. Hit-testing against transformed
    // rects makes targets slide under the pointer while the drag is still active.
    const top = listTop + el.offsetTop - listEl.scrollTop;
    return { id: el.dataset.wsId ?? "", top, bottom: top + el.offsetHeight };
  });
}
