import { useEffect, useState, type RefObject } from "react";
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
 * TWO things move the answer, and missing either leaves a panel hanging where
 * its chip used to be:
 *
 *   the window resizes — the clamp that keeps the panel on screen depends on
 *     how much screen there is;
 *   the roster changes — a chip appearing to the LEFT of the open one shifts
 *     it along, and the panel is anchored to a chip, not to a place. An agent
 *     starting or a first report landing does exactly that, with the panel
 *     open and the provider unchanged.
 *
 * Scrolling deliberately does not, and that is not an omission: the panel is
 * absolutely positioned inside the group it measures against, so a scroll
 * carries the group, the chip and the panel together and the offset between
 * them is unchanged.
 */
export function useUsagePanelAnchor(
  groupRef: RefObject<HTMLElement | null>,
  /** The chip the panel belongs to, or null while it is closed. */
  openProvider: string | null,
  /** Identifies the chip row's composition — a new value means the chips may
   *  have moved even though the open provider did not. */
  rosterKey: string,
): number | null {
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    if (openProvider === null) {
      setLeft(null);
      return;
    }
    const place = () => {
      const group = groupRef.current;
      const chip = group?.querySelector<HTMLElement>(
        `[data-usage-chip="${CSS.escape(openProvider)}"]`,
      );
      // The panel's width is the stylesheet's to decide, so it is measured
      // rather than restated here — a second copy of that number would drift
      // the first time the panel is resized.
      const panel = group?.querySelector<HTMLElement>(".usage-panel");
      if (!group || !chip || !panel) return;
      setLeft(
        usagePanelLeft({
          chipLeft: chip.getBoundingClientRect().left,
          groupLeft: group.getBoundingClientRect().left,
          panelWidth: panel.getBoundingClientRect().width,
          viewportWidth:
            document.documentElement.clientWidth || window.innerWidth,
        }),
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [groupRef, openProvider, rosterKey]);

  return left;
}
