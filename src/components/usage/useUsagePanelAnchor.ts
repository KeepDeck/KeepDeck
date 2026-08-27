import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type RefObject,
} from "react";
import { usagePanelLeft } from "../../domain/usage/panelPlacement";

/**
 * Where the account-limits panel hangs, as an offset from the chip group's own
 * left edge (the panel is positioned inside that group).
 *
 * The RULE is `usagePanelLeft` and is pure; all that happens here is the
 * measuring, which is browser work with a lifetime — a listener to add and
 * take away. That is a job of its own, and it is why it is not sitting in the
 * middle of `UsageChips` beside the roster, the palette and the open state.
 *
 * `null` until measured. The caller keeps the panel invisible for that one
 * frame: drawn first at the stylesheet's default position and then moved would
 * read as the panel jumping into place.
 *
 * MEASURED AFTER EVERY RENDER, which is the whole design. The panel is
 * anchored to a chip, not to a place, and the number of things that move a
 * chip is not a list anyone can finish: another agent's chip appearing to its
 * left, an account reporting a second window so the neighbour grows a column,
 * a report going stale and growing a warning mark, a countdown ticking from
 * "1h 0m" to "59m". Each was a separate near-miss, and each would have been a
 * separate patch. A render is what all of them look like from here, so a
 * render is the signal — and the state only changes when the number does, so
 * measuring again costs a layout read and stops.
 *
 * The one change that moves the chip WITHOUT a render is the window resizing,
 * which is why that keeps a listener of its own.
 *
 * Scrolling deliberately moves nothing, and that is not an omission: the panel
 * is absolutely positioned inside the group it measures against, so a scroll
 * carries the group, the chip and the panel together and the offset between
 * them is unchanged.
 */
export function useUsagePanelAnchor(
  groupRef: RefObject<HTMLElement | null>,
  /** The chip the panel belongs to, or null while it is closed. */
  openProvider: string | null,
): number | null {
  const [left, setLeft] = useState<number | null>(null);

  const place = useCallback(() => {
    const group = groupRef.current;
    if (openProvider === null || !group) return;
    const chip = group.querySelector<HTMLElement>(
      `[data-usage-chip="${CSS.escape(openProvider)}"]`,
    );
    // The panel's width is the stylesheet's to decide, so it is measured
    // rather than restated here — a second copy of that number would drift
    // the first time the panel is resized.
    const panel = group.querySelector<HTMLElement>(".usage-panel");
    if (!chip || !panel) return;
    const next = usagePanelLeft({
      chipLeft: chip.getBoundingClientRect().left,
      groupLeft: group.getBoundingClientRect().left,
      panelWidth: panel.getBoundingClientRect().width,
      viewportWidth: document.documentElement.clientWidth || window.innerWidth,
    });
    // Same number, same state: React bails out and the extra render this
    // effect would otherwise cause never happens.
    setLeft((current) => (current === next ? current : next));
  }, [groupRef, openProvider]);

  // Deliberately no dependency list — see above. Layout-phase so the panel is
  // already placed on the frame it first appears in.
  useLayoutEffect(() => {
    if (openProvider === null) {
      setLeft(null);
      return;
    }
    place();
  });

  useEffect(() => {
    if (openProvider === null) return;
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [openProvider, place]);

  return left;
}
