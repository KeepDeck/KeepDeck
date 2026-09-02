/**
 * What one line of a codex rollout says about its pane, while the rollout is
 * still being written.
 *
 * The same edge as claude's and for the same reason: codex pushes no hook
 * when a turn is aborted, so its own store is the only witness, and the
 * pane's idea of whether this agent is working rests on that edge arriving.
 *
 * Where it differs is the shape: codex nests. An abort is
 * `payload.type === "turn_aborted"` under an `event_msg` line, one level
 * down and inside a class that also carries its usage numbers and the
 * assistant's own text.
 *
 * EVERY abort reason maps to `interrupted`, not only the user's Esc. That is
 * the reading this deck already settled on and it is kept deliberately: an
 * aborted turn did not complete, and `turn-end` would announce "finished"
 * for a turn that was cut. A quiet "Interrupted" is the smaller lie, and its
 * announce is suppressed by design; in the common non-Esc case a new turn's
 * own edge follows at once and settles the display anyway.
 */
import {
  jsonl,
  type JsonlRequest,
  type SessionTailDialect,
} from "@keepdeck/plugin-api";

/**
 * The carried record, as the watch below projects it.
 *
 * The keys are the DOTTED PATHS that were asked for, not a rebuilt nesting:
 * what arrives is what was requested, under the name it was requested by.
 */
interface CarriedRollout {
  timestamp?: unknown;
  "payload.type"?: unknown;
}

function instantOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

export const codexTail: SessionTailDialect<JsonlRequest, CarriedRollout> = {
  format: jsonl<CarriedRollout>(),

  /**
   * codex names no store for itself: its reporter reports a session id, and
   * the rollout lives in a day-partitioned tree under the CLI's own home.
   * Finding it is still the host's, and this asks only for what the host
   * already resolved — the move of that search is its own step.
   */
  follow: (pane) => (pane.store ? { path: pane.store } : null),

  /**
   * `event_msg` lines whose payload is an abort, and the two fields that
   * place it.
   *
   * Narrower than "every event_msg" on purpose. codex's usage numbers ride
   * `event_msg` too, and so does the assistant's own text — carrying the
   * whole class would put a session's output on the app's bus to learn one
   * fact. The nested clause is what keeps it to the one record type.
   *
   * The abort's REASON is not carried, because nothing reads it: every
   * reason means the same edge here. A field named but unread is a field
   * that leaves the store for nothing.
   */
  watch: {
    match: [
      { key: "type", equals: "event_msg" },
      { key: "payload.type", equals: "turn_aborted" },
    ],
    keep: ["timestamp", "payload.type"],
  },

  read: (record) => {
    if (record["payload.type"] !== "turn_aborted") return null;
    const at = instantOf(record.timestamp);
    // Undatable is unreportable: the staleness guard places this instant
    // against the turn the edge would end, and an edge it cannot place would
    // end a turn that is running.
    return at === null ? null : { kind: "interrupted", at };
  },

  /**
   * Every carried record IS an abort — the watch saw to that — so there is
   * nothing this dialect knowingly passes over. A record that arrives here
   * and is not one is a rollout whose shape moved, and saying so is the
   * whole point of the question.
   */
  ignores: () => false,
};
