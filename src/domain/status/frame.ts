import type { PaneActivity } from "./activity";

/** The one frame a status surface wears — a closed set so the CSS ladder
 * is exhaustive and a new rung is a compile error at the view. The
 * `selected` rung means "the surface the user's cursor owns": the
 * selected pane's border on the deck, the active workspace's green on
 * the rail — one rung, because it is one fact (where the cursor is), and
 * one hex on purpose. */
export type StatusFrame =
  | "failed"
  | "waiting"
  | "selected"
  | "working"
  | "done"
  | "none";

/**
 * The single home of the frame priority ladder ([`paneBody`] precedent —
 * the domain decides, surfaces render). One frame, never a blend: mixing
 * two frames on one border was tried and rejected.
 *
 *   failed > waiting > selected > working > done > none
 *
 * The two ATTENTION states outrank selection because selection is where
 * the cursor is, not where the eyes are — a selected pane's approval
 * prompt is exactly as easy to miss as any other pane's. Working frames
 * but yields to selection: the cursor's place outranks a live fact the
 * selected pane's own header already spells out, and a working frame on
 * it would hide that place. Done ranks last: a courtesy tail of a
 * finished turn, weaker than the live fact of a running one.
 *
 * `selectionFrame` is whether the surface would wear the selection border
 * at all (the deck's existing rule: selected, not maximized, not the only
 * pane) — that visibility rule stays the caller's; this ladder only ranks.
 */
export function paneFrame(
  activity: PaneActivity | undefined,
  selectionFrame: boolean,
): StatusFrame {
  if (activity?.state === "failed") return "failed";
  if (activity?.state === "waiting") return "waiting";
  if (selectionFrame) return "selected";
  if (activity?.state === "working") return "working";
  if (activity?.state === "done") return "done";
  return "none";
}

/** How loudly one activity ranks in the fold — working outranks done
 * (a live fact beats a finished turn's tail) but stays below the
 * attention pair. */
const SEVERITY: Record<PaneActivity["state"], number> = {
  failed: 4,
  waiting: 3,
  working: 2,
  done: 1,
};

/**
 * The same ladder folded over a whole workspace — the rail dot's one
 * answer. Literally [`paneFrame`] of the workspace's LOUDEST pane, so the
 * two surfaces can never rank attention differently: any pane's attention
 * wins for the workspace (the ACTIVE workspace's dot goes amber/red too —
 * active is where the cursor is, not where the eyes are), and working or
 * done are worth a dot only on a background workspace, exactly as they
 * yield to selection on a pane.
 */
export function workspaceFrame(
  activities: Iterable<PaneActivity | undefined>,
  active: boolean,
): StatusFrame {
  let loudest: PaneActivity | undefined;
  for (const activity of activities) {
    if (!activity) continue;
    if (!loudest || SEVERITY[activity.state] > SEVERITY[loudest.state]) {
      loudest = activity;
    }
  }
  return paneFrame(loudest, active);
}
