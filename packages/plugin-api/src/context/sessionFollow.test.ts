import { describe, expect, it } from "vitest";
import type { AgentStatusEvent } from "./status.ts";
import type {
  PluginSessionStore,
  ReadOutcome,
  ReadStop,
  SessionCursor,
} from "./sessionRead.ts";
import { jsonl, type JsonlRequest } from "./sessionRead.ts";
import { addPass, driftedAway, followOnce } from "./sessionFollow.ts";
import type { SessionTailDialect } from "./sessionTail.ts";

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

/** A store that hands back a fixed batch and reports how it was asked. */
function storeOf(
  records: Record[],
  outcome: { stopped: ReadStop; next?: SessionCursor } = { stopped: "exhausted" },
) {
  const asked: unknown[] = [];
  const store: PluginSessionStore = {
    read: async (_format, request, consume) => {
      asked.push(request);
      for (const record of records) {
        if (consume(record as never) === "enough") break;
      }
      return { payloadBytes: 0, items: records.length, ...outcome } as ReadOutcome;
    },
  };
  return { store, asked };
}

const REQUEST: JsonlRequest = { path: "/store/ses_1" };

describe("followOnce", () => {
  it("reports nothing on the FIRST look, however much the store holds", () => {
    // Arming on a session that has been running for hours must not replay
    // its turns. Its history is a record of turns that are over, and an old
    // interrupt acted on now would end the turn running right this second.
    const { store } = storeOf([
      { type: "user", interruptedMessageId: "old", at: 1 },
      { type: "user", interruptedMessageId: "older", at: 2 },
    ]);
    const seen: AgentStatusEvent[] = [];
    return followOnce({
      store,
      dialect,
      request: REQUEST,
      emit: (event) => seen.push(event),
    }).then((step) => {
      expect(seen).toEqual([]);
      expect(step.pass).toEqual({ reported: 0, ignored: 0, unknown: 0 });
      expect(step.restarted).toBe(false);
    });
  });

  it("reports what was appended once it has a position", async () => {
    const { store, asked } = storeOf([
      { type: "assistant" },
      { type: "user", interruptedMessageId: "m", at: 900 },
      { type: "brand-new-shape" },
    ]);
    const seen: AgentStatusEvent[] = [];
    const step = await followOnce({
      store,
      dialect,
      request: REQUEST,
      from: "j1:100:100" as SessionCursor,
      emit: (event) => seen.push(event),
    });

    expect(seen).toEqual([{ kind: "interrupted", at: 900 }]);
    expect(step.pass).toEqual({ reported: 1, ignored: 1, unknown: 1 });
    // The cursor rides IN the request, because only the transport knows how
    // to address a position in its own store.
    expect(asked).toEqual([{ path: "/store/ses_1", from: "j1:100:100" }]);
  });

  it("reports NOTHING when the store was replaced under it", async () => {
    // A rewritten file is a different conversation at the same path. What
    // this pass read cannot be trusted to belong to the store now there, so
    // acting on any of it would attribute one session's interrupt to
    // another. The caller is told to drop what it derived.
    const { store } = storeOf([{ type: "user", interruptedMessageId: "m", at: 5 }], {
      stopped: "changed",
    });
    const seen: AgentStatusEvent[] = [];
    const step = await followOnce({
      store,
      dialect,
      request: REQUEST,
      from: "j1:100:100" as SessionCursor,
      emit: (event) => seen.push(event),
    });

    expect(seen).toEqual([]);
    expect(step.restarted).toBe(true);
    expect(step.next).toBeUndefined();
  });

  it("passes the store's own resume point back to the caller", async () => {
    const { store } = storeOf([], {
      stopped: "budget",
      next: "j1:512:512" as SessionCursor,
    });
    const step = await followOnce({
      store,
      dialect,
      request: REQUEST,
      from: "j1:100:100" as SessionCursor,
      emit: () => {},
    });
    expect(step.next).toBe("j1:512:512");
  });
});

describe("driftedAway", () => {
  it("stays quiet for a store whose records are mostly ordinary", () => {
    // The measured shape of two of the three real stores: most records are
    // legitimately ignored. A rule that fired on "said nothing" would fire
    // on every healthy pane.
    expect(driftedAway({ reported: 2, ignored: 400, unknown: 0 })).toBe(false);
    expect(driftedAway({ reported: 0, ignored: 0, unknown: 0 })).toBe(false);
  });

  it("stays quiet for a handful of new shapes", () => {
    // A CLI adding a record type in a release is ordinary, and firing on the
    // first one would train everyone to ignore the warning.
    expect(driftedAway({ reported: 5, ignored: 90, unknown: 8 })).toBe(false);
  });

  it("fires when the dialect has stopped reading its own agent", () => {
    // The case that cost somebody else sixteen silent incidents: the format
    // moved, every record now falls through, and nothing says so.
    expect(driftedAway({ reported: 0, ignored: 3, unknown: 40 })).toBe(true);
  });

  it("needs BOTH a majority and a quantity, because either alone lies", () => {
    // A majority alone fires on a quiet store that saw two odd records; a
    // quantity alone fires on a busy healthy store that saw twenty over a
    // long session while placing thousands.
    expect(driftedAway({ reported: 0, ignored: 1, unknown: 3 })).toBe(false);
    expect(driftedAway({ reported: 900, ignored: 900, unknown: 25 })).toBe(false);
  });
});

describe("addPass", () => {
  it("accumulates across looks, because one look at a quiet store sees nothing", () => {
    const total = [
      { reported: 1, ignored: 2, unknown: 3 },
      { reported: 0, ignored: 5, unknown: 1 },
    ].reduce(addPass, { reported: 0, ignored: 0, unknown: 0 });
    expect(total).toEqual({ reported: 1, ignored: 7, unknown: 4 });
  });
});
