/**
 * The one write that marks a pane suspended.
 *
 * Three acts put a pane down by a decision — a single suspend, a team's, and
 * an archive — and each has its own rule for WHICH panes it may take. What it
 * does to a pane it takes is the same everywhere, so it is written once: two
 * copies of this line had already grown apart in their comments.
 *
 * Kept out of the panes barrel on purpose: it is the writers' detail, not a
 * question anyone else asks of a pane.
 */
import type { Pane } from "./model";

/** `pane`, down by the person's decision as of `at` (dates its card) — or,
 * when it was rising from a suspension, back to that suspension with its
 * own date: a wake taken back, or cancelled by a Suspend, is not a new
 * decision. */
export function suspendedAt(pane: Pane, at: string): Pane {
  const from = pane.idle?.reason === "waking" ? pane.idle.from : undefined;
  return { ...pane, idle: from?.reason === "suspended" ? from : { reason: "suspended", at } };
}
