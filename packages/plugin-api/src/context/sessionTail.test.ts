import { describe, expect, it } from "vitest";
import type { AgentStatusEvent } from "./status.ts";
import { jsonl, type JsonlRequest } from "./sessionRead.ts";
import { tailPass, type SessionTailDialect } from "./sessionTail.ts";

/** A record shape close enough to a real transcript to make the three
 * answers distinguishable: one that MEANS something, one that is ordinary
 * traffic, and one this dialect has never seen. */
type Record = { type?: string; interruptedMessageId?: string; at?: number };

const dialect: SessionTailDialect<JsonlRequest, Record> = {
  format: jsonl<Record>(),
  follow: (pane) => (pane.sessionId ? { path: `/store/${pane.sessionId}` } : null),
  read: (record) =>
    record.type === "user" && record.interruptedMessageId
      ? { kind: "interrupted", at: record.at ?? 0 }
      : null,
  ignores: (record) => record.type === "user" || record.type === "assistant",
};

describe("tailPass", () => {
  it("separates the two reasons a dialect says nothing", () => {
    // The whole point of `ignores`. A store is mostly records that mean
    // nothing to the deck, and passing over them is correct; a record whose
    // shape nobody has seen is a format that moved. `read` returning null
    // cannot tell those apart, and the second one silent is how a drifted
    // format goes unnoticed until a pane has been "working" for an hour.
    const seen: AgentStatusEvent[] = [];
    const pass = tailPass(
      dialect,
      [
        { type: "user", interruptedMessageId: "msg_1", at: 500 },
        { type: "assistant" },
        { type: "user" },
        { type: "something-new" },
        {},
      ],
      (event) => seen.push(event),
    );

    expect(pass).toEqual({ reported: 1, ignored: 2, unknown: 2 });
    expect(seen).toEqual([{ kind: "interrupted", at: 500 }]);
  });

  it("carries the record's own instant, not the moment it was read", () => {
    // A followed store is read up to a poll interval late. Stamped with
    // receipt time, a marker would outrank the turn it belongs behind and
    // the staleness guard could never drop it.
    const seen: AgentStatusEvent[] = [];
    tailPass(dialect, [{ type: "user", interruptedMessageId: "m", at: 42 }], (e) =>
      seen.push(e),
    );
    expect(seen[0]?.at).toBe(42);
  });

  it("counts a pass over nothing as a pass over nothing", () => {
    // A store that grew by a record the dialect reported and nothing else
    // must not look the same as one that grew by records nobody recognised.
    expect(tailPass(dialect, [], () => {})).toEqual({
      reported: 0,
      ignored: 0,
      unknown: 0,
    });
  });

  it("asks a dialect where to look, and takes null for an answer", () => {
    // A pane whose agent has not spoken yet has no session to follow, and
    // that is an ordinary state rather than a failure — the store arrives on
    // a later pass. Topology is the dialect's answer because the shape of a
    // store is the agent's business: a host that knew it would be a host
    // that names agents.
    expect(dialect.follow({ sessionId: "ses_1", store: null, cwd: null })).toEqual({
      path: "/store/ses_1",
    });
    expect(dialect.follow({ sessionId: null, store: null, cwd: "/work" })).toBeNull();
  });
});
