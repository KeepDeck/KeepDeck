/**
 * How the person's ask to stop a pane, or to bring one back, ended. The page
 * refuses up front what it can tell cannot happen now — in the deck's own
 * reasons, which every surface words the same way — and otherwise hands the
 * ask to the machine, whose refusal comes back as it gave it.
 */
import type { ResumeRequest, SuspendOutcome } from "../deck";
import type { IntentOutcome } from ".";

type NotTaken = Exclude<IntentOutcome, { kind: "accepted" }>;

/** A pane asked back: it is rising, it cannot rise now and why, or the
 * machine refused or did not answer. */
export type ResumeOutcome = { kind: "resuming" } | { kind: "blocked"; why: Exclude<ResumeRequest, "resuming"> } | NotTaken;

/** One member a team's Resume or Suspend asked, and how its ask ended. */
export interface MemberAnswer<Outcome> {
  paneId: string;
  outcome: Outcome;
}

/** A pane asked to stop and stay: it is being suspended, it cannot be now
 * and why, or the machine refused or did not answer. */
export type SuspendResult = { kind: "suspending" } | { kind: "blocked"; why: Exclude<SuspendOutcome, "suspended"> } | NotTaken;
