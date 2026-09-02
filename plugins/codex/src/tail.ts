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
  type PluginContext,
  type SessionTailDialect,
} from "@keepdeck/plugin-api";
import { findRollout } from "./store";

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

/**
 * The half that needs nothing from the machine: which records to carry, what
 * one means, and what this dialect claims to know.
 *
 * Apart from `follow` because the split is real — deciding what a record
 * means is a pure reading of it, while finding the store is a walk over a
 * filesystem. Keeping them apart is what lets the normalizer and the tests
 * use the reading without conjuring a plugin context to do it.
 */
export const codexRecords = {
  watch: {
    match: [
      { key: "type", equals: "event_msg" },
      { key: "payload.type", equals: "turn_aborted" },
    ],
    keep: ["timestamp", "payload.type"],
    lane: "status",
  },

  read: (record: CarriedRollout) => {
    if (record["payload.type"] !== "turn_aborted") return null;
    const at = instantOf(record.timestamp);
    // Undatable is unreportable: the staleness guard places this instant
    // against the turn the edge would end, and an edge it cannot place would
    // end a turn that is running.
    return at === null ? null : ({ kind: "interrupted", at } as const);
  },

  /**
   * Every carried record IS an abort — the watch saw to that — so there is
   * nothing this dialect knowingly passes over. A record that arrives here
   * and is not one is a rollout whose shape moved, and saying so is the
   * whole point of the question.
   */
  ignores: () => false,
} satisfies Pick<
  SessionTailDialect<JsonlRequest, CarriedRollout>,
  "watch" | "read" | "ignores"
>;

export const codexTail = (
  ctx: PluginContext,
): SessionTailDialect<JsonlRequest, CarriedRollout> => ({
  format: jsonl<CarriedRollout>(),
  ...codexRecords,

  /**
   * codex names no store for itself: its reporter reports a session id and
   * nothing else, so the rollout has to be FOUND — in a day-partitioned tree
   * under the CLI's own home, by a filename that carries the id.
   *
   * That search used to live in the backend, which meant the host knew where
   * a foreign CLI keeps its files and would have to be edited when codex
   * moved house. It is the same walk this plugin's history browser already
   * does over the same tree, and it now shares one description of it.
   *
   * A pane that reported an id but has not worked yet has no rollout — codex
   * writes it when the first turn lands — and null here is that ordinary
   * state, not a failure.
   */
  follow: async (pane) => {
    if (pane.store) return { path: pane.store };
    if (!pane.sessionId) return null;
    const path = await findRollout(ctx, pane.sessionId);
    return path ? { path } : null;
  },
});
