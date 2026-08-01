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
 * marker's own source time for tail-recovered interrupts. The one compare
 * lives in the `interrupted` case; everything else only displays them.
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

/**
 * Fold one edge into the pane's activity. Pure; the newest edge wins —
 * ordering discipline (stale tokens, dead panes, replays) belongs to the
 * tracker feeding this, not here. The one exception is `interrupted`,
 * which arrives on a second channel and must not overwrite a turn that
 * already ended (see the case).
 */
export function reduceActivity(
  current: PaneActivity | null,
  event: AgentStatusEvent,
): PaneActivity {
  switch (event.kind) {
    case "turn-start":
      return { state: "working", since: event.at };
    case "waiting":
      return { state: "waiting", since: event.at, reason: event.reason };
    case "resumed":
      return { state: "working", since: event.at };
    case "turn-end":
      return { state: "done", at: event.at, interrupted: false };
    case "interrupted":
      // An interrupt marker arrives on a second, slower channel (the
      // transcript tailer polls), so it can trail the turn it aborted by
      // seconds — two orderings must not corrupt the state it lands on:
      // a marker after the edge that already ENDED its turn (re-labelling
      // a completed turn would be false), and a marker after the NEXT
      // turn's start — the hook lane is near-instant, so a user who Escs
      // and re-prompts within the poll interval has a running turn the
      // stale marker must not end. The marker carries its own source
      // time; one that predates the current phase is the old turn's.
      if (current?.state === "done" || current?.state === "failed") {
        return current;
      }
      if (
        (current?.state === "working" || current?.state === "waiting") &&
        event.at < current.since
      ) {
        return current;
      }
      return { state: "done", at: event.at, interrupted: true };
    case "turn-failed":
      return {
        state: "failed",
        at: event.at,
        error: event.error,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      };
  }
}
