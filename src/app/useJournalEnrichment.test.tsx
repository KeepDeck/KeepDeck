// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexLookupAnswer } from "../ipc/history";

const ipc = vi.hoisted(() => ({
  indexLookup: vi.fn<(...args: unknown[]) => Promise<IndexLookupAnswer[]>>(),
  lookupWarns: [] as string[],
}));
vi.mock("../ipc/history", () => ({ indexLookup: ipc.indexLookup }));
vi.mock("../ipc/log", () => ({
  log: { warn: (_tag: string, msg: string) => ipc.lookupWarns.push(msg) },
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { useJournalEnrichment, rowKeyOf } from "./useJournalEnrichment";
import { joinJournalRow } from "../domain/journal";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** The hook under whatever (revision, scanning) the test currently drives. */
let api: ReturnType<typeof useJournalEnrichment>;

function Probe({ revision, scanning }: { revision: number; scanning: boolean }) {
  api = useJournalEnrichment(revision, scanning);
  return null;
}

describe("useJournalEnrichment", () => {
  let root: Root;
  let resolvers: ((answers: IndexLookupAnswer[]) => void)[];
  let rejecters: ((reason: unknown) => void)[];
  let revision: number;
  let scanning: boolean;

  beforeEach(() => {
    resolvers = [];
    rejecters = [];
    ipc.indexLookup.mockReset();
    ipc.indexLookup.mockImplementation(
      () =>
        new Promise<IndexLookupAnswer[]>((resolve, reject) => {
          resolvers.push(resolve);
          rejecters.push(reject);
        }),
    );
    ipc.lookupWarns.length = 0;
    revision = 1;
    scanning = false;
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  const mount = () =>
    act(async () => root.render(createElement(Probe, { revision, scanning })));
  const rerender = () =>
    act(async () => root.render(createElement(Probe, { revision, scanning })));

  const KEYS = {
    own: { agent: "claude", sessionId: "s-1" },
    foreign: { agent: "claude", sessionId: "kimi-9" },
    unknown: { agent: "claude", sessionId: "nope" },
  };

  it("asks nothing before any scan has run or started — 'not answered yet' is not an ask", async () => {
    revision = 0;
    scanning = false;
    await mount();
    act(() => api.declare([KEYS.own]));
    await act(async () => {});
    expect(ipc.indexLookup).not.toHaveBeenCalled();
    expect(api.entries.size).toBe(0);
  });

  it("a declaration landing in the SAME commit as the mount fires ONE ask, not two", async () => {
    // The real mount path: the declaring list is a CHILD of the hook's
    // owner, so the declared ref is populated before the effect's tick
    // re-run — caught live by the real-pair integration suite. The same
    // in-flight ask must not be fired twice.
    revision = 1;
    await mount();
    // Simulate the child-in-same-commit declare: ref mutated, then the
    // tick the effect re-runs on.
    act(() => api.declare([KEYS.own, KEYS.unknown]));
    await act(async () => {});
    expect(ipc.indexLookup).toHaveBeenCalledTimes(1);
    expect(ipc.indexLookup).toHaveBeenCalledWith([KEYS.own, KEYS.unknown]);

    // A PARTIAL overlap still fires, carrying the FULL owed set — the
    // newer ask supersedes the older landing, so nothing may be dropped
    // from it.
    act(() => api.declare([{ agent: "codex", sessionId: "new" }]));
    await act(async () => {});
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);
    expect(ipc.indexLookup).toHaveBeenLastCalledWith([
      KEYS.own,
      KEYS.unknown,
      { agent: "codex", sessionId: "new" },
    ]);

    // The superseded first landing applies nothing; the second answers
    // everything it carried.
    await act(async () =>
      resolvers[1]([
        { status: "hit", reference: "/store/s-1", title: null },
        { status: "absent" },
        { status: "hit", reference: "/store/new", title: "late" },
      ]),
    );
    expect(api.entries.size).toBe(3);
    await act(async () =>
      resolvers[0]([
        { status: "hit", reference: "/store/s-1", title: "STALE" },
        { status: "absent" },
      ]),
    );
    expect(api.entries.get(rowKeyOf(KEYS.own))).not.toMatchObject({ title: "STALE" });
  });

  it("one batched ask covers every declared key; answers land per key", async () => {
    await mount();
    act(() => api.declare([KEYS.own, KEYS.foreign, KEYS.unknown]));
    await act(async () => {});
    expect(ipc.indexLookup).toHaveBeenCalledExactlyOnceWith([
      KEYS.own,
      KEYS.foreign,
      KEYS.unknown,
    ]);

    await act(async () =>
      resolvers[0]([
        { status: "hit", reference: "/store/s-1", title: "the real title" },
        { status: "foreign", agents: ["kimi"] },
        { status: "absent" },
      ]),
    );
    expect(api.entries.get(rowKeyOf(KEYS.own))).toEqual({
      kind: "hit",
      reference: "/store/s-1",
      title: "the real title",
    });
    expect(api.entries.get(rowKeyOf(KEYS.foreign))).toEqual({
      kind: "foreign",
      agents: ["kimi"],
    });
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).toEqual({ kind: "absent" });
  });

  it("declarations from several lists union into ONE shared ask — not one ask per list", async () => {
    await mount();
    // Two mounted lists declare their own rows inside the same commit.
    act(() => {
      api.declare([{ agent: "claude", sessionId: "a" }]);
      api.declare([{ agent: "codex", sessionId: "b" }]);
    });
    await act(async () => {});
    expect(ipc.indexLookup).toHaveBeenCalledTimes(1);
    expect(ipc.indexLookup).toHaveBeenCalledWith([
      { agent: "claude", sessionId: "a" },
      { agent: "codex", sessionId: "b" },
    ]);
  });

  it("a revision bump re-asks only what is not a hit — scan batches fill titles as they land", async () => {
    await mount();
    act(() => api.declare([KEYS.own, KEYS.unknown]));
    await act(async () => {});
    await act(async () =>
      resolvers[0]([
        { status: "hit", reference: "/store/s-1", title: null },
        { status: "absent" },
      ]),
    );

    revision += 1; // a scan batch landed
    await rerender();
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);
    expect(ipc.indexLookup).toHaveBeenLastCalledWith([KEYS.unknown]);

    // The batch delivered the previously-absent session: it turns hit.
    await act(async () =>
      resolvers[1]([{ status: "hit", reference: "/store/nope", title: "late arrival" }]),
    );
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).toEqual({
      kind: "hit",
      reference: "/store/nope",
      title: "late arrival",
    });

    // The next bump finds only hits — no ask at all.
    revision += 1;
    await rerender();
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);
  });

  it("a refused FIRST ask names itself — an error entry, never an absence", async () => {
    await mount();
    act(() => api.declare([KEYS.unknown]));
    await act(async () => {});
    await act(async () => rejecters[0](new Error("index unreachable")));
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).toEqual({ kind: "error" });
    expect(ipc.lookupWarns.length).toBe(1);
  });

  it("a refused re-ask keeps prior answers verbatim — never degrades them to the error", async () => {
    // Known answers are not on trial again: an absent/foreign entry
    // stays exactly what it was when the refresh ask fails.
    await mount();
    act(() => api.declare([KEYS.foreign, KEYS.unknown]));
    await act(async () => {});
    await act(async () =>
      resolvers[0]([
        { status: "foreign", agents: ["kimi"] },
        { status: "absent" },
      ]),
    );

    revision += 1;
    await rerender();
    await act(async () => rejecters[1](new Error("boom")));
    expect(api.entries.get(rowKeyOf(KEYS.foreign))).toEqual({
      kind: "foreign",
      agents: ["kimi"],
    });
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).toEqual({ kind: "absent" });
  });

  it("an answer landing after a newer ask applies nothing", async () => {
    await mount();
    act(() => api.declare([KEYS.own]));
    await act(async () => {});
    // The first ask is in flight; a revision bump supersedes it.
    revision += 1;
    await rerender();
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);

    // The STALE landing arrives last: it must not apply.
    await act(async () =>
      resolvers[1]([{ status: "hit", reference: "/fresh", title: "newest" }]),
    );
    await act(async () =>
      resolvers[0]([{ status: "hit", reference: "/stale", title: "oldest" }]),
    );
    expect(api.entries.get(rowKeyOf(KEYS.own))).toEqual({
      kind: "hit",
      reference: "/fresh",
      title: "newest",
    });
  });

  it("a superseded landing dropped mid-scan does not clobber the table either", async () => {
    // Superseded answers apply nothing — including a superseded FAILURE:
    // a refusal from an ask a newer one replaced must not error-mark keys
    // the newer ask is still answering.
    await mount();
    act(() => api.declare([KEYS.own]));
    await act(async () => {});
    revision += 1;
    await rerender();
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);

    await act(async () => rejecters[0](new Error("old ask failed")));
    expect(api.entries.size).toBe(0);
    await act(async () =>
      resolvers[1]([{ status: "hit", reference: "/store/s-1", title: "newest" }]),
    );
    expect(api.entries.get(rowKeyOf(KEYS.own))).toEqual({
      kind: "hit",
      reference: "/store/s-1",
      title: "newest",
    });
  });

  it("end to end: rows titled with the agent's LABEL get their real names once the rescan lands", async () => {
    // The shape the step doc measured: a fresh index (schema wipe) answers
    // absent for everything; the rescan's landed batches bump the revision
    // and the re-ask turns the label-titled rows into titled ones. Store
    // and join composed over the real journal-record shape.
    const labelTitled = {
      agent: "claude",
      sessionId: "s-1",
      cwd: "/repo",
      title: "Claude Code", // the label, frozen into the journal
      boundAt: "2026-07-19T10:00:00.000Z",
      state: "closed" as const,
      endedAt: "2026-07-19T11:00:00.000Z",
    };
    revision = 1;
    await mount();
    act(() => api.declare([{ agent: "claude", sessionId: "s-1" }]));
    await act(async () => {});
    await act(async () => resolvers[0]([{ status: "absent" }]));

    // Before the scan lands, the join shows the label — the only name the
    // record itself has — and keeps looking for the index's answer.
    const before = joinJournalRow(
      labelTitled,
      api.entries.get(rowKeyOf({ agent: "claude", sessionId: "s-1" })),
      "Claude Code",
      false,
    );
    expect(before.status).toBe("nothing-to-read");

    // The rescan lands the row: revision bump, re-ask, a titled hit.
    revision += 1;
    await rerender();
    await act(async () =>
      resolvers[1]([
        { status: "hit", reference: "/store/s-1", title: "fix the auth bug" },
      ]),
    );
    const after = joinJournalRow(
      labelTitled,
      api.entries.get(rowKeyOf({ agent: "claude", sessionId: "s-1" })),
      "Claude Code",
      false,
    );
    expect(after.title).toBe("fix the auth bug");
    expect(after.read).toEqual({ source: "index", reference: "/store/s-1" });
    expect(after.status).toBeNull();
  });
});
