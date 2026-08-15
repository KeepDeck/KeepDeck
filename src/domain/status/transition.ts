import type { PaneActivity } from "./activity";

/** What one activity transition owes the notification center. With dated
 * per-event entries there is nothing to withdraw — every "announce" APPENDS
 * a fact to the history, and a fact never becomes a lie when the wait it
 * named is answered later. */
export type ActivityTransition = "announce" | "none";

/**
 * The announce/silent decision for one pane's activity change — the SAME
 * "what counts as attention" semantics the frame ladder encodes, settled
 * in the domain so the producer stays a thin adapter and the table is
 * testable without mocking the center.
 *
 * The reducer's absorption rules do the pre-filtering: an edge that changes
 * nothing keeps its object identity and never reaches this table, so a
 * waiting→waiting arrival here IS a changed question (the reason moved) and
 * announces — as its own entry, dated, beside the one it supersedes. An
 * interrupt is the user's own hand: they are looking at the pane, so it
 * announces nothing, whatever it cut.
 */
export function activityTransition(
  before: PaneActivity | undefined,
  after: PaneActivity,
): ActivityTransition {
  switch (after.state) {
    case "waiting":
      return "announce";
    case "failed":
      return "announce";
    case "working":
      return "none";
    case "done":
      if (after.interrupted) {
        return "none";
      }
      return before?.state === "working" || before?.state === "waiting"
        ? "announce"
        : "none";
  }
}
