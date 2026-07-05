import type { RailItemRect } from "../domain/deck";

/** Read each rail item's vertical extent from the DOM, in document order —
 * the impure feed for the pure `railItemAtY` hit-test, split exactly like
 * `app/dragDrop.ts` / `domain/deck`. Items are tagged with `data-ws-id`. */
export function collectRailItemRects(listEl: HTMLElement): RailItemRect[] {
  return [...listEl.querySelectorAll<HTMLElement>("[data-ws-id]")].map((el) => {
    const rect = el.getBoundingClientRect();
    return { id: el.dataset.wsId ?? "", top: rect.top, bottom: rect.bottom };
  });
}
