import { describe, expect, it } from "vitest";
import { watchMatches, watchProject } from "@keepdeck/plugin-api";
import { codexTail } from "./tail";

const ISO = "2026-08-01T10:00:00Z";
const abort = (reason?: string) => ({
  timestamp: ISO,
  type: "event_msg",
  payload: { type: "turn_aborted", ...(reason ? { reason } : {}) },
});

describe("codexTail", () => {
  it("carries only the abort, not the class it hides in", () => {
    // codex's usage numbers ride `event_msg` too, and so does the
    // assistant's own text. Carrying the whole class would put a session's
    // output on the app's bus to learn one fact — the nested clause is what
    // keeps it to the one record type.
    expect(watchMatches(codexTail.watch, abort())).toBe(true);
    expect(
      watchMatches(codexTail.watch, {
        timestamp: ISO,
        type: "event_msg",
        payload: { type: "token_count", info: { total: 1 } },
      }),
    ).toBe(false);
    expect(
      watchMatches(codexTail.watch, {
        timestamp: ISO,
        type: "turn_context",
        payload: { model: "gpt-5" },
      }),
    ).toBe(false);
  });

  it("keeps the dotted names it asked for, and the payload's bulk stays behind", () => {
    expect(
      watchProject(codexTail.watch, {
        timestamp: ISO,
        type: "event_msg",
        payload: {
          type: "turn_aborted",
          reason: "budget_exceeded",
          message: "everything the model said before giving up",
        },
      }),
    ).toEqual({
      timestamp: ISO,
      "payload.type": "turn_aborted",
    });
  });

  it("reads EVERY abort reason as an interrupt, which is the reading already settled", () => {
    // Deliberate and inherited, not an oversight. An aborted turn did not
    // complete, and `turn-end` would announce "finished" for a turn that was
    // cut; a quiet "Interrupted" is the smaller lie, and its announce is
    // suppressed by design. The reason is not even carried — nothing reads
    // it, and a field named but unread leaves the store for nothing.
    for (const reason of [undefined, "interrupted", "budget_exceeded", "replaced"]) {
      expect(
        codexTail.read(watchProject(codexTail.watch, abort(reason))),
        String(reason),
      ).toEqual({ kind: "interrupted", at: Date.parse(ISO) });
    }
  });

  it("refuses an abort it cannot date", () => {
    // The staleness guard places this instant against the turn the edge
    // would end; one it cannot place would end a turn that is running.
    expect(
      codexTail.read({ "payload.type": "turn_aborted", timestamp: "not a date" }),
    ).toBeNull();
    expect(codexTail.read({ "payload.type": "turn_aborted" })).toBeNull();
  });

  it("claims to know nothing it did not ask for", () => {
    // Every carried record IS an abort, because the watch saw to it. One
    // that arrives and is not is a rollout whose shape moved, and the count
    // of those is the only warning anyone gets.
    expect(codexTail.ignores({ "payload.type": "something-new" })).toBe(false);
  });
});
