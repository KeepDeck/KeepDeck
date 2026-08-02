import type { AgentStatusEvent, StatusWaitReason } from "@keepdeck/plugin-api";

/**
 * What a pane's agent is DOING right now — the fold of its turn-lifecycle
 * edges. Deliberately not part of [`PaneBody`]: that one answers "is there
 * a process / what does the body show", this one "what is the live process
 * up to". A rate-limited turn leaves the process alive and the body on
 * `terminal` — conflating the two is the run-vs-stopped mistake again.
 *
 * Runtime-only, like `pane.head`: never serialized. A persisted "working"
 * would resurrect next launch as a claim about a process that no longer
 * exists.
 *
 * Timestamps are unix milliseconds — receipt time for hook edges, the
 * marker's own source time for tail-recovered markers. Staleness is a
 * property of the EDGE STREAM, not of one edge kind, and the guards below
 * come in two flavors, each catching what the other cannot:
 *
 * - The TIME compare (`at < since`) catches only slow-channel edges — a
 *   tail marker trails the hook lane by up to a poll interval and carries
 *   its own honest time. Hook edges are stamped at APPLY time, so their
 *   `at` is monotonic in processing order and the compare is inert for
 *   them; it becomes load-bearing for `waiting` too the moment any lane
 *   mints a wait with a source time.
 * - The STATE absorbs (done/failed stand) catch reordered HOOK envelopes,
 *   which a receipt-stamped time cannot see its own reordering in.
 *
 * Only a fresh `turn-start` wins unconditionally — nothing but the
 * user's own prompt mints one.
 */
export type PaneActivity =
  /** A turn is running. `since` is when THIS running phase began — a wait
   * that resolves starts a new phase, so the age answers "how long since
   * you could have walked away". */
  | { state: "working"; since: number }
  /** The turn is parked on the user. */
  | { state: "waiting"; since: number; reason: StatusWaitReason }
  /** The last turn is over. `interrupted` says HOW: completed, or cut by
   * the user — the card reads differently ("Done" vs "Interrupted"). */
  | { state: "done"; at: number; interrupted: boolean }
  /** The last turn died on an API error. `error` is the CLI's typed reason
   * (`rate_limit`, `authentication_failed`, …), `detail` its prose. */
  | { state: "failed"; at: number; error: string; detail?: string };

/** A turn-ending edge must not corrupt the state it lands on. Two
 * orderings, one rule: an edge after the turn already ENDED is the old
 * turn's echo (re-labelling a completed turn would be false), and an edge
 * whose own time predates the current phase belongs to the turn BEFORE
 * that phase — the hook lane is near-instant, so a user who ends a turn
 * and re-prompts within a poll interval has a running turn a trailing
 * marker must not end.
 *
 * The predicate exists so `return current` type-checks non-null in the
 * true branch. CAVEAT for the next editor: TypeScript narrows the FALSE
 * branch to `null` — a lie (a fresh working/waiting reaches it too) —
 * so never read `current` after a false result; mint a new object. */
function endedTurnStands(
  current: PaneActivity | null,
  at: number,
): current is PaneActivity {
  if (current?.state === "done" || current?.state === "failed") return true;
  return (
    (current?.state === "working" || current?.state === "waiting") &&
    at < current.since
  );
}

/**
 * Fold one edge into the pane's activity. Pure; ordering discipline for
 * IDENTITY (stale tokens, dead panes, replays) belongs to the tracker
 * feeding this — but ordering discipline for TIME lives here, because
 * edges arrive on two channels (near-instant hooks, a polling tailer) and
 * even one channel can reorder within a tick. Returning `current`
 * UNCHANGED is load-bearing: the tracker drops identical results without
 * an emit, so an absorbed edge never re-renders or re-announces.
 */
export function reduceActivity(
  current: PaneActivity | null,
  event: AgentStatusEvent,
): PaneActivity {
  switch (event.kind) {
    case "turn-start":
      // Only the user's own prompt mints this edge — a new turn trumps
      // whatever the old one left behind.
      return { state: "working", since: event.at };
    case "waiting":
      // A wait can only park a RUNNING turn. After done/failed the edge is
      // an echo (claude's idle nudge fires up to seconds late and can
      // trail the Stop that already ended the turn) — a wait it reports
      // has nothing left to resolve it.
      if (current?.state === "done" || current?.state === "failed") {
        return current;
      }
      // The slow-channel time guard, inert for hook waits (receipt-stamped)
      // but armed the day a tail-recovered wait exists — same rule as the
      // ending edges: an edge older than the phase belongs to before it.
      if (
        (current?.state === "working" || current?.state === "waiting") &&
        event.at < current.since
      ) {
        return current;
      }
      // A re-asserted wait is the SAME question: keep the phase start (the
      // tooltip's age must not reset on every nudge) and the identity (no
      // re-announce). A different reason is a new question — fresh phase.
      if (current?.state === "waiting" && current.reason === event.reason) {
        return current;
      }
      return { state: "waiting", since: event.at, reason: event.reason };
    case "resumed":
      // A resolution resolves a WAIT. Mid-turn it is a no-op (a tool
      // completing while working proves nothing new), and after done or
      // failed it is the answered prompt's echo — resurrecting a turn the
      // CLI already closed would advertise a run that isn't happening.
      if (current?.state === "waiting" || current === null) {
        return { state: "working", since: event.at };
      }
      return current;
    case "turn-end":
      if (endedTurnStands(current, event.at)) return current;
      return { state: "done", at: event.at, interrupted: false };
    case "interrupted":
      if (endedTurnStands(current, event.at)) return current;
      return { state: "done", at: event.at, interrupted: true };
    case "turn-failed":
      if (endedTurnStands(current, event.at)) return current;
      return {
        state: "failed",
        at: event.at,
        error: event.error,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      };
  }
}
