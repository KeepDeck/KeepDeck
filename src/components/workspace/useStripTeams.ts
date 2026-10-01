import { useEffect, useReducer } from "react";
import { expandTeams, type ExpandEvent } from "../../presentation/stripExpand";
import type { StripView } from "../../presentation/stripView";

/**
 * Which workspace the slid-open strip lists the teams of — the state
 * `expandTeams` decides, held beside the strip. Opening lists the active
 * workspace's teams; shutting lists nothing; a chevron moves the one list.
 */
export function useStripTeams(open: boolean, view: StripView) {
  const [expanded, dispatch] = useReducer(
    (state: string | null, event: ExpandEvent) => expandTeams(state, event),
    null,
  );
  const active = view.marks.find((mark) => mark.active);
  useEffect(() => {
    dispatch(
      open
        ? { kind: "open", activeId: active?.id ?? "", activeHasTeams: (active?.teams.length ?? 0) > 0 }
        : { kind: "close" },
    );
    // Only the strip opening or shutting re-decides; the active mark's
    // teams changing under an open strip must not yank a list the person
    // moved elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return { expanded, toggle: (wsId: string) => dispatch({ kind: "toggle", wsId }) };
}
