import { describe, expect, it } from "vitest";
import { watchMatches, watchProject } from "@keepdeck/plugin-api";
import { codexRecords } from "./tail";

const ISO = "2026-08-01T10:00:00Z";
const abort = (reason?: string) => ({
  timestamp: ISO,
  type: "event_msg",
  payload: { type: "turn_aborted", ...(reason ? { reason } : {}) },
});

describe("codexTail", () => {
  it("carries terminal failures without the assistant's output", () => {
    const line = {
      timestamp: ISO,
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "private conversation",
        error: { codex_error_info: "usage_limit_exceeded", message: "Usage exhausted" },
      },
    };
    const watch = codexRecords.watches.find((candidate) => watchMatches(candidate, line));
    expect(watch).toBeDefined();
    const carried = watchProject(watch!, line);
    expect(JSON.stringify(carried)).not.toContain("private conversation");
    expect(codexRecords.read(carried)).toEqual({
      kind: "turn-failed", at: Date.parse(ISO), error: "rate_limit", detail: "Usage exhausted",
    });
  });

  it("does not turn successes or retry errors into terminal failures", () => {
    for (const payload of [
      { type: "task_complete", error: null },
      { type: "task_complete" },
      { type: "error", codex_error_info: "usage_limit_exceeded", message: "retrying" },
    ]) {
      const line = { timestamp: ISO, type: "event_msg", payload };
      const watch = codexRecords.watches.find((candidate) => watchMatches(candidate, line));
      expect(watch ? codexRecords.read(watchProject(watch, line)) : null).toBeNull();
    }
  });

  it("keeps other terminal errors and degrades unreadable reasons safely", () => {
    const read = (error: unknown, timestamp = ISO) => codexRecords.read({
      timestamp, "payload.type": "task_complete", "payload.error": error,
    });
    expect(read({ codex_error_info: "future_error", message: "detail" })).toEqual({
      kind: "turn-failed", at: Date.parse(ISO), error: "future_error", detail: "detail",
    });
    expect(read({ codex_error_info: { stream_error: {} } })).toEqual({
      kind: "turn-failed", at: Date.parse(ISO), error: "unknown",
    });
    for (const error of [null, undefined, "error", []]) expect(read(error)).toBeNull();
    expect(read({ message: "failed" }, "not a date")).toBeNull();
  });

  it("carries only the abort, not the class it hides in", () => {
    // codex's usage numbers ride `event_msg` too, and so does the
    // assistant's own text. Carrying the whole class would put a session's
    // output on the app's bus to learn one fact — the nested clause is what
    // keeps it to the one record type.
    expect(watchMatches(codexRecords.watches[0], abort())).toBe(true);
    expect(
      watchMatches(codexRecords.watches[0], {
        timestamp: ISO,
        type: "event_msg",
        payload: { type: "token_count", info: { total: 1 } },
      }),
    ).toBe(false);
    expect(
      watchMatches(codexRecords.watches[0], {
        timestamp: ISO,
        type: "turn_context",
        payload: { model: "gpt-5" },
      }),
    ).toBe(false);
  });

  it("keeps the dotted names it asked for, and the payload's bulk stays behind", () => {
    expect(
      watchProject(codexRecords.watches[0], {
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
        codexRecords.read(watchProject(codexRecords.watches[0], abort(reason))),
        String(reason),
      ).toEqual({ kind: "interrupted", at: Date.parse(ISO) });
    }
  });

  it("refuses an abort it cannot date", () => {
    // The staleness guard places this instant against the turn the edge
    // would end; one it cannot place would end a turn that is running.
    expect(
      codexRecords.read({ "payload.type": "turn_aborted", timestamp: "not a date" }),
    ).toBeNull();
    expect(codexRecords.read({ "payload.type": "turn_aborted" })).toBeNull();
  });

  it("claims to know nothing it did not ask for", () => {
    // Every carried record IS an abort, because the watch saw to it. One
    // that arrives and is not is a rollout whose shape moved, and the count
    // of those is the only warning anyone gets.
    expect(codexRecords.ignores()).toBe(false);
  });
});
