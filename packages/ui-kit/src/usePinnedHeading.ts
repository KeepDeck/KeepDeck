import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { pinnedFrame, type PinnedRow } from "./pinnedFrame";

/**
 * The pinned heading kept in step with the SCROLL, not with renders: the
 * windowed list re-renders only when its range of rows changes, while the
 * push (`pinnedFrame`) runs over the last heading's height — inside one
 * row's scroll, between two renders. So every scroll event places it
 * itself: the shift is written straight onto the layer (no render per
 * scroll), and the group it heads re-renders only when the first row in
 * view changes.
 *
 * CONTRACT, as `useRowAnchoring`'s: the scroll element is mounted with the
 * hook and stays the same element for its life.
 */
export function usePinnedHeading(
  scrollRef: RefObject<HTMLElement | null>,
  rows: readonly PinnedRow[],
  height: number,
  heads: ((index: number) => boolean) | null,
): { first: number; layerRef: RefObject<HTMLDivElement | null> } {
  const layerRef = useRef<HTMLDivElement>(null);
  const [first, setFirst] = useState(-1);
  const latest = useRef({ rows, height, heads });
  // From a render (`settled`): the rows are this render's, and an empty
  // window means nothing to pin. From a scroll: the rows are the last
  // render's, and a fling past them keeps the heading until the window
  // catches up rather than dropping it for a frame.
  const place = useRef((settled: boolean) => {
    const list = scrollRef.current;
    const { rows: mounted, height: tall, heads: starts } = latest.current;
    if (!list || !starts) return;
    const frame = pinnedFrame(mounted, list.scrollTop, tall, starts);
    if (frame.first < 0 && !settled) return;
    const layer = layerRef.current;
    if (layer) layer.style.transform = frame.shift < 0 ? `translateY(${frame.shift}px)` : "";
    setFirst(frame.first);
  });
  useLayoutEffect(() => {
    latest.current = { rows, height, heads };
    place.current(true);
  });
  useEffect(() => {
    const list = scrollRef.current;
    if (!list) return;
    const onScroll = () => place.current(false);
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
    // The scroll element is stable for the mount (CONTRACT above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { first, layerRef };
}
