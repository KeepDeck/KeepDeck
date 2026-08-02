import type { PaneActivity } from "./activity";

/** What one activity transition owes the notification center. */
export type ActivityTransition = "announce" | "retract" | "none";

/**
 * The announce/retract/silent decision for one pane's activity change —
 * the SAME "what counts as attention" semantics the frame ladder encodes,
 * settled in the domain so the producer stays a thin adapter and the
 * table is testable without mocking the center.
 *
 * `after === undefined` is the pane LEAVING the store (its process
 * retired, or the pane left the deck): only a standing wait is a lie
 * worth withdrawing then — a done/failed entry is history, and history
 * may stand.
 *
 * The reducer's absorption rules do the pre-filtering: an edge that
 * changes nothing keeps its object identity and never reaches this
 * table, so a waiting→waiting arrival here IS a changed question (the
 * reason moved) and announces — replacing the stale text under the same
 * tag. An interrupt is the user's own hand: they are looking at the
 * pane, so it announces nothing, and if it cut a wait it withdraws it.
 */
export function activityTransition(
  before: PaneActivity | undefined,
  after: PaneActivity | undefined,
): ActivityTransition {
  if (after === undefined) {
    return before?.state === "waiting" ? "retract" : "none";
  }
  switch (after.state) {
    case "waiting":
      return "announce";
    case "failed":
      return "announce";
    case "working":
      return before?.state === "waiting" ? "retract" : "none";
    case "done":
      if (after.interrupted) {
        return before?.state === "waiting" ? "retract" : "none";
      }
      return before?.state === "working" || before?.state === "waiting"
        ? "announce"
        : "none";
  }
}
