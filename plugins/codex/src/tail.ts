/**
 * What one line of a codex rollout says about its pane, while the rollout is
 * still being written.
 *
 * Native Interrupt exists in 0.153.2, but this plugin also supports older
 * hook sets. Its own store supplies turn_aborted, and
 * task_complete with a structured error (verified on 0.153.2).
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
  isJsonRecord,
  jsonl,
  turnFailedEvent,
  type JsonlRequest,
  type PluginContext,
  type SessionTailDialect,
} from "@keepdeck/plugin-api";
import { findRollout } from "./store";
import { codexQuestionWatches } from "./questions";

/**
 * The carried record, as the watch below projects it.
 *
 * The keys are the DOTTED PATHS that were asked for, not a rebuilt nesting:
 * what arrives is what was requested, under the name it was requested by.
 */
interface CarriedRollout {
  type?: unknown;
  timestamp?: unknown;
  "payload.type"?: unknown;
  "payload.error"?: unknown;
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
  watches: [{
    match: [
      { key: "type", equals: "event_msg" },
      { key: "payload.type", equals: "turn_aborted" },
    ],
    keep: ["timestamp", "payload.type"],
    lane: "status",
  }, {
    // 0.153.2 records terminal API failures here, without firing Stop.
    // An ordinary `error` may be a retry; only task_complete ends the turn.
    match: [
      { key: "type", equals: "event_msg" },
      { key: "payload.type", equals: "task_complete" },
      { key: "payload.error" },
    ],
    keep: ["timestamp", "payload.type", "payload.error"],
    lane: "status",
  }, ...codexQuestionWatches],

  read: (record: CarriedRollout) => {
    const at = instantOf(record.timestamp);
    // Undatable is unreportable: the staleness guard places this instant
    // against the turn the edge would end, and an edge it cannot place would
    // end a turn that is running.
    if (at === null) return null;
    if (record["payload.type"] === "turn_aborted") return { kind: "interrupted", at } as const;
    const error = record["payload.error"];
    if (record["payload.type"] !== "task_complete" || !isJsonRecord(error)) return null;
    return turnFailedEvent(
      at,
      error.codex_error_info === "usage_limit_exceeded" ? "rate_limit" : error.codex_error_info,
      error.message,
    );
  },

  // These need correlation/mode in the normalizer, not a stateless read.
  ignores: (record: CarriedRollout) => record.type === "turn_context" || record.type === "response_item",
} satisfies Pick<
  SessionTailDialect<JsonlRequest, CarriedRollout>,
  "watches" | "read" | "ignores"
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
