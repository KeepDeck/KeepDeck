import type { PaneActivity } from "./activity";

/** The one frame a pane surface wears — a closed set so the CSS ladder is
 * exhaustive and a new rung is a compile error at the view. */
export type PaneFrame = "failed" | "waiting" | "selected" | "done" | "none";

/**
 * The single home of the frame priority ladder ([`paneBody`] precedent —
 * the domain decides, surfaces render). One frame, never a blend: mixing
 * two frames on one border was tried and rejected.
 *
 *   failed > waiting > selected > done > none
 *
 * The two ATTENTION states outrank selection because selection is where
 * the cursor is, not where the eyes are — a selected pane's approval
 * prompt is exactly as easy to miss as any other pane's. Done yields to
 * selection: it is a courtesy signal, and the selected pane is the one
 * surface whose outcome the user is closest to already knowing. Working
 * never frames — a quiet deck is the point.
 *
 * `selectionFrame` is whether the surface would wear the selection border
 * at all (the deck's existing rule: selected, not maximized, not the only
 * pane) — that visibility rule stays the caller's; this ladder only ranks.
 */
export function paneFrame(
  activity: PaneActivity | undefined,
  selectionFrame: boolean,
): PaneFrame {
  if (activity?.state === "failed") return "failed";
  if (activity?.state === "waiting") return "waiting";
  if (selectionFrame) return "selected";
  if (activity?.state === "done") return "done";
  return "none";
}
