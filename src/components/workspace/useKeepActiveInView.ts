import { useLayoutEffect, type RefObject } from "react";
import { markGroups } from "../../app/stripDnd";
import { scrollToShow } from "../../presentation/stripExpand";

/**
 * At rest the strip's column shows the workspace on screen: when the
 * active one changes (a hotkey, a notification, the crumb) and its mark is
 * scrolled out of the column, bring it in by the least distance. Not while
 * the strip is open — the person is reading it — nor under a drag, which
 * owns the column then; and not before the column has a height to show.
 */
export function useKeepActiveInView(
  listRef: RefObject<HTMLElement | null>,
  activeId: string | null,
  idle: boolean,
) {
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !idle || activeId === null || list.clientHeight === 0) return;
    const mark = markGroups(list).find((el) => el.dataset.wsId === activeId);
    if (!mark) return;
    const listBox = list.getBoundingClientRect();
    const top = mark.getBoundingClientRect().top - listBox.top;
    const target = scrollToShow(list.scrollTop, list.clientHeight, {
      top,
      bottom: top + mark.offsetHeight,
    });
    if (target !== null) list.scrollTop = target;
    // The active workspace changing is the only trigger; `idle` gates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
}
