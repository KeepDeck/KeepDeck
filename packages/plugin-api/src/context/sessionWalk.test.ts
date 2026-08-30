import { describe, expect, it } from "vitest";
import type { AgentTranscriptEntry } from "./agents.ts";
import type {
  PluginSessionStore,
  ReadOutcome,
  ReadStop,
  SessionCursor,
  SessionFormat,
} from "./sessionRead.ts";
import { CONTENT_CAP, walkSession, type SessionDialect } from "./sessionWalk.ts";

/** A store that hands over the records it was given and stops the way it was
 * told to — the walk's whole job is what it does with records and with the
 * reason a read ended, so both are the inputs here. */
function fakeStore(
  records: unknown[],
  stopped: ReadStop = "exhausted",
  sourceBytes?: number,
): PluginSessionStore & { reads: number } {
  const store = {
    reads: 0,
    async read(
      _format: SessionFormat<unknown, unknown>,
      _request: unknown,
      consume: (item: unknown) => "more" | "enough",
    ): Promise<ReadOutcome> {
      store.reads += 1;
      let items = 0;
      for (const record of records) {
        items += 1;
        if (consume(record) === "enough") {
          return {
            payloadBytes: 10,
            items,
            stopped: "satisfied",
            sourceBytes,
            next: "j1:10:20" as SessionCursor,
          };
        }
      }
      return { payloadBytes: 10, items, stopped, sourceBytes };
    },
  };
  return store as PluginSessionStore & { reads: number };
}

const FORMAT = { id: "fake" } as SessionFormat<Record<string, never>, unknown>;

/** The simplest dialect there is: one record, one turn. */
const flat: SessionDialect<null, unknown> = {
  begin: () => null,
  step: (_state, item) => [item as AgentTranscriptEntry],
  end: () => [],
};

/** A dialect that cannot finish a turn until the NEXT record tells it to —
 * kimi's shape, and the reason `end` exists. */
function buffering(): SessionDialect<{ held: string[] }, string> {
  return {
    begin: () => ({ held: [] }),
    step: (state, item) => {
      if (item !== "FLUSH") {
        state.held.push(item);
        return [];
      }
      const text = state.held.join("");
      state.held.length = 0;
      return text ? [{ role: "assistant", text }] : [];
    },
    end: (state) =>
      state.held.length > 0
        ? [{ role: "assistant", text: state.held.join("") }]
        : [],
  };
}

describe("walkSession", () => {
  it("joins the dialect's turns into the content the index consumes", async () => {
    const store = fakeStore([
      { role: "user", text: "fix the parser" },
      { role: "assistant", text: "done" },
    ]);

    const walked = await walkSession({
      store,
      format: FORMAT,
      request: {},
      dialect: flat,
    });

    expect(walked.content).toBe("fix the parser\ndone");
    expect(walked.title).toBe("fix the parser");
    expect(walked.shortfall).toBeUndefined();
  });

  it("flushes what the dialect still holds when the records run out", async () => {
    const store = fakeStore(["a", "b"]);

    const walked = await walkSession({
      store,
      format: FORMAT,
      request: {},
      dialect: buffering(),
    });

    expect(walked.content).toBe("ab");
  });

  it("flushes what the dialect holds even when the read stopped short", async () => {
    // The silent loss this exists to prevent: a dialect holding a turn at a
    // budget stop drops it with no error and no shortfall — nothing but a
    // diff against the old output would ever show the turn missing.
    const store = fakeStore(["a", "b"], "budget", 100);

    const walked = await walkSession({
      store,
      format: FORMAT,
      request: {},
      dialect: buffering(),
    });

    expect(walked.content).toBe("ab");
  });

  it("marks the content short when the read stopped on the budget", async () => {
    const store = fakeStore([{ role: "user", text: "hi" }], "budget", 900);

    const walked = await walkSession({
      store,
      format: FORMAT,
      request: {},
      dialect: flat,
    });

    expect(walked.shortfall).toEqual([
      { kind: "bytes", size: 900, readBytes: 10 },
    ]);
  });

  it("does NOT mark the content short when it simply had enough", async () => {
    // A conversation longer than the cap is the common case, not a fault.
    // Marking it would put "partly shown" on most healthy sessions, and a
    // warning that fires on everything stops being read.
    const long = { role: "user", text: "x".repeat(CONTENT_CAP) };
    const store = fakeStore([long, long, long], "exhausted", 9_000_000);

    const walked = await walkSession({
      store,
      format: FORMAT,
      request: {},
      dialect: flat,
    });

    expect(walked.outcome.stopped).toBe("satisfied");
    expect(walked.shortfall).toBeUndefined();
    expect(walked.content.length).toBeLessThan(CONTENT_CAP * 2);
  });

  it("stops the read as soon as it has all the text it keeps", async () => {
    // The point of the whole mechanism: the store is not read past the point
    // where the answer stops changing. A hundred records are on offer and
    // two are taken.
    const long = { role: "user", text: "x".repeat(CONTENT_CAP) };
    const store = fakeStore(Array.from({ length: 100 }, () => long));

    const walked = await walkSession({
      store,
      format: FORMAT,
      request: {},
      dialect: flat,
    });

    expect(walked.outcome.items).toBe(2);
  });

  it("re-reads once when the store moved under it, then gives up", async () => {
    // Splicing the halves of two different files would show a conversation
    // that never happened; re-reading forever would cost more of the same.
    const store = fakeStore([{ role: "user", text: "hi" }], "changed", 50);

    const walked = await walkSession({
      store,
      format: FORMAT,
      request: {},
      dialect: flat,
    });

    expect(store.reads).toBe(2);
    expect(walked.outcome.stopped).toBe("changed");
    expect(walked.shortfall).toEqual([{ kind: "bytes", size: 50, readBytes: 10 }]);
  });

  it("hands back the dialect's state, so a plugin reads what it noticed", async () => {
    // cwd, a summary line, a model name: facts a store carries in the very
    // records the walk was going to pass anyway. Opening the store a second
    // time to collect them is the double read this replaces.
    const dialect: SessionDialect<{ cwd?: string }, { cwd?: string }> = {
      begin: () => ({}),
      step: (state, item) => {
        state.cwd ??= item.cwd;
        return [];
      },
      end: () => [],
    };
    const store = fakeStore([{ cwd: "/repo" }, { cwd: "/elsewhere" }]);

    const walked = await walkSession({
      store,
      format: FORMAT as SessionFormat<Record<string, never>, { cwd?: string }>,
      request: {},
      dialect,
    });

    expect(walked.state.cwd).toBe("/repo");
  });
});
