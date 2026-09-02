import { describe, expect, it } from "vitest";
import type { AgentStatusEvent } from "./status.ts";
import { jsonl, type JsonlRequest } from "./sessionRead.ts";
import {
  tailPass,
  watchMatches,
  watchProject,
  type SessionTailDialect,
} from "./sessionTail.ts";

/** A record shape close enough to a real transcript to make the three
 * answers distinguishable: one that MEANS something, one that is ordinary
 * traffic, and one this dialect has never seen. */
type Record = { type?: string; interruptedMessageId?: string; at?: number };

const dialect: SessionTailDialect<JsonlRequest, Record> = {
  format: jsonl<Record>(),
  watch: {
    match: [{ key: "type", equals: "user" }, { key: "interruptedMessageId" }],
    keep: ["type", "interruptedMessageId", "at"],
  },
  follow: async (pane) =>
    pane.sessionId ? { path: `/store/${pane.sessionId}` } : null,
  read: (record) =>
    record.type === "user" && record.interruptedMessageId
      ? { kind: "interrupted", at: record.at ?? 0 }
      : null,
  ignores: (record) => record.type === "user" || record.type === "assistant",
};

describe("watchMatches", () => {
  it("joins its clauses with AND, and nothing else", () => {
    // Two rules and no more, on purpose: equality and presence. Everything
    // past that belongs in `read`, where a real language already exists — a
    // descriptor that grows conditions is a query language nobody voted for.
    const watch = dialect.watch;
    expect(watchMatches(watch, { type: "user", interruptedMessageId: "m" })).toBe(true);
    expect(watchMatches(watch, { type: "assistant", interruptedMessageId: "m" })).toBe(
      false,
    );
    expect(watchMatches(watch, { type: "user" })).toBe(false);
  });

  it("does not count a blank value as presence", () => {
    // A key written empty is how several stores say "no value". Carried as a
    // hit, it would hand the dialect records that say nothing — and for this
    // dialect, an empty interrupted-message id is exactly a record that says
    // nothing.
    expect(
      watchMatches(dialect.watch, { type: "user", interruptedMessageId: "" }),
    ).toBe(false);
    expect(
      watchMatches(dialect.watch, { type: "user", interruptedMessageId: null }),
    ).toBe(false);
  });
});

describe("watchProject", () => {
  it("copies the named fields and leaves the store's contents behind", () => {
    // The half that matters for more than cost. A dialect that never names a
    // message field cannot leak a message — not as a rule anyone remembers,
    // but because the field is never copied.
    const record = {
      type: "user",
      interruptedMessageId: "m",
      at: 5,
      message: { content: "everything the model said" },
      cwd: "/home/somebody/secret-project",
    };
    expect(watchProject(dialect.watch, record)).toEqual({
      type: "user",
      interruptedMessageId: "m",
      at: 5,
    });
  });

  it("omits a named field the record does not carry", () => {
    expect(watchProject(dialect.watch, { type: "user" })).toEqual({ type: "user" });
  });
});

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

  it("asks a dialect where to look, and takes null for an answer", async () => {
    // A pane whose agent has not spoken yet has no session to follow, and
    // that is an ordinary state rather than a failure — the store arrives on
    // a later pass. Topology is the dialect's answer because the shape of a
    // store is the agent's business: a host that knew it would be a host
    // that names agents.
    await expect(
      dialect.follow({ sessionId: "ses_1", store: null, cwd: null }),
    ).resolves.toEqual({ path: "/store/ses_1" });
    await expect(
      dialect.follow({ sessionId: null, store: null, cwd: "/work" }),
    ).resolves.toBeNull();
  });
});
