import { type RefObject, useCallback, useEffect } from "react";

/** How close to the end (px) pulls the next page in. Exported so every
 * scroll-driven pager (incl. the browser's transcript viewer, which runs its
 * own offset paging) shares one trigger distance. */
export const NEAR_END = 240;

/**
 * Scroll-driven lazy paging shared by the session lists ([F8]): fetch the next
 * page as the scroll container nears its end, and keep filling while the loaded
 * rows are shorter than the viewport (no scrollbar yet, so a scroll alone can
 * never fire). Returns the handler to wire onto the container's `onScroll`;
 * `count` re-runs the fill check after each landed page.
 */
export function useScrollPaging(
  ref: RefObject<HTMLElement | null>,
  paging: { hasMore: boolean; loadMore(): void },
  count: number,
): () => void {
  const { hasMore, loadMore } = paging;
  const maybeLoad = useCallback(() => {
    const el = ref.current;
    // loadMore itself guards the in-flight and exhausted states.
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END) {
      loadMore();
    }
  }, [ref, loadMore]);
  useEffect(() => {
    if (hasMore) maybeLoad();
  }, [hasMore, maybeLoad, count]);
  return maybeLoad;
}
