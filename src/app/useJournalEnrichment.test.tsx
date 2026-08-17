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

  it("pending spans the scan-end gap: revision bumped, the re-ask's answer still owed", async () => {
    // The manager's settle publishes scanning:false and the revision bump
    // in ONE snapshot; the re-ask effect runs after the render it causes.
    // `pending` must already be true in that render — answered-under-an-
    // older-revision is render-pure, it does not wait for the effect.
    await mount(); // revision 1
    act(() => api.declare([KEYS.unknown]));
    await act(async () => {});
    await act(async () => resolvers[0]([{ status: "absent" }]));
    expect(api.pending).toBe(false); // answered under the current revision

    revision += 1; // the scan settled — one publish, both fields
    await rerender();
    expect(api.pending).toBe(true); // the re-ask is owed/in flight

    // The re-ask lands ABSENT again under the new revision: a settled
    // verdict is still reachable — pending false exactly once the
    // CURRENT revision has answered.
    await act(async () => resolvers[1]([{ status: "absent" }]));
    expect(api.pending).toBe(false);
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).toEqual({ kind: "absent" });

    // And a hit landing under a bump ends the provisional state too —
    // a fresh key, since hits are never re-asked.
    act(() => api.declare([KEYS.own]));
    await act(async () => {});
    await act(async () =>
      resolvers[2]([{ status: "hit", reference: "/store/s-1", title: "late", mtime: 9 }]),
    );
    expect(api.pending).toBe(false);
  });

  it("a declaration landing in the SAME commit as the mount fires ONE ask, not two", async () => {
    // The real mount path: the declaring list is a CHILD of the hook's
    // owner, so the declared ref is populated before the effect's tick
    // re-run — caught live by the real-pair integration suite. The same
    // in-flight ask must not be fired twice — nor queue a chase for
    // itself.
    revision = 1;
    await mount();
    // Simulate the child-in-same-commit declare: ref mutated, then the
    // tick the effect re-runs on.
    act(() => api.declare([KEYS.own, KEYS.unknown]));
    await act(async () => {});
    expect(ipc.indexLookup).toHaveBeenCalledTimes(1);
    expect(ipc.indexLookup).toHaveBeenCalledWith([KEYS.own, KEYS.unknown]);

    // The landing with NO queued chase fires nothing further — the
    // duplicate-run guard left the queue empty.
    await act(async () =>
      resolvers[0]([
        { status: "hit", reference: "/store/s-1", title: null, mtime: 9 },
        { status: "absent" },
      ]),
    );
    expect(ipc.indexLookup).toHaveBeenCalledTimes(1);
    expect(api.entries.size).toBe(2);
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
        { status: "hit", reference: "/store/s-1", title: "the real title", mtime: 9 },
        { status: "foreign", agents: ["kimi"] },
        { status: "absent" },
      ]),
    );
    expect(api.entries.get(rowKeyOf(KEYS.own))).toEqual({
      kind: "hit",
      reference: "/store/s-1",
      title: "the real title",
      mtime: 9,
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
        { status: "hit", reference: "/store/s-1", title: null, mtime: 9 },
        { status: "absent" },
      ]),
    );

    revision += 1; // a scan batch landed
    await rerender();
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);
    expect(ipc.indexLookup).toHaveBeenLastCalledWith([KEYS.unknown]);

    // The batch delivered the previously-absent session: it turns hit.
    await act(async () =>
      resolvers[1]([{ status: "hit", reference: "/store/nope", title: "late arrival", mtime: 9 }]),
    );
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).toEqual({
      kind: "hit",
      reference: "/store/nope",
      title: "late arrival",
      mtime: 9,
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

  it("a burst of bumps while one ask flies: one in flight, ONE catch-up after, the same table as sequential — pending never dips", async () => {
    // peer-4 measured the pre-coalescing seam piling ten concurrent asks
    // on a synthetic burst. The requirement: at most one ask in flight,
    // exactly one catch-up pass after its landing (full set of that
    // moment), and `pending` must not dip between the landing and the
    // catch-up — that dip is the aa332ad2 lie's little sibling.
    await mount(); // revision 1
    act(() => api.declare([KEYS.own, KEYS.unknown]));
    await act(async () => {});
    expect(ipc.indexLookup).toHaveBeenCalledTimes(1); // the one flight

    // The burst: five rapid revisions while the ask hangs.
    for (let bump = 0; bump < 5; bump += 1) {
      revision += 1;
      await rerender();
      expect(ipc.indexLookup).toHaveBeenCalledTimes(1); // never a second
      expect(api.pending).toBe(true); // ...and the verdict stays withheld
    }

    // The flight lands under revision 1 — stale data, harmless: the
    // catch-up is already owed. THIS frame is the dangerous one: the
    // landing published answeredAt=1 against revision 6.
    await act(async () =>
      resolvers[0]([
        { status: "absent" },
        { status: "absent" },
      ]),
    );
    expect(api.pending).toBe(true); // answered-under-older-revision holds

    // The catch-up fires ONCE, with the full still-owed set.
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);
    expect(ipc.indexLookup).toHaveBeenLastCalledWith([KEYS.own, KEYS.unknown]);
    // And it answers under the CURRENT revision: pending finally rests.
    await act(async () =>
      resolvers[1]([
        { status: "hit", reference: "/store/s-1", title: "burst title", mtime: 9 },
        { status: "absent" },
      ]),
    );
    expect(api.pending).toBe(false);
    const burstFinal = new Map(api.entries);

    // Equivalence: the same landings driven sequentially, one ask per
    // bump, must produce the same table.
    await act(async () => root.unmount());
    ipc.indexLookup.mockClear();
    resolvers.length = 0;
    rejecters.length = 0;
    revision = 1;
    document.body.innerHTML = "<div id='host2'></div>";
    root = createRoot(document.getElementById("host2")!);
    await mount();
    act(() => api.declare([KEYS.own, KEYS.unknown]));
    await act(async () => {});
    await act(async () =>
      resolvers[0]([{ status: "absent" }, { status: "absent" }]),
    );
    revision += 1;
    await rerender();
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);
    await act(async () =>
      resolvers[1]([
        { status: "hit", reference: "/store/s-1", title: "burst title", mtime: 9 },
        { status: "absent" },
      ]),
    );
    expect(api.pending).toBe(false);
    expect(api.entries).toEqual(burstFinal);
  });

  it("a mid-flight declaration joins the CATCH-UP, not a second flight", async () => {
    // A new key declared while an ask flies must not fire alongside it —
    // the catch-up carries the full set, so the new key is answered with
    // everything else still owed.
    await mount();
    act(() => api.declare([KEYS.own, KEYS.unknown]));
    await act(async () => {});
    expect(ipc.indexLookup).toHaveBeenCalledTimes(1);

    act(() => api.declare([{ agent: "codex", sessionId: "new" }]));
    await act(async () => {});
    expect(ipc.indexLookup).toHaveBeenCalledTimes(1); // queued, not fired

    await act(async () =>
      resolvers[0]([
        { status: "hit", reference: "/store/s-1", title: null, mtime: 9 },
        { status: "absent" },
      ]),
    );
    // The catch-up: the FULL still-owed set — the landed hit drops out,
    // the absent and the newcomer stay in.
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);
    expect(ipc.indexLookup).toHaveBeenLastCalledWith([
      KEYS.unknown,
      { agent: "codex", sessionId: "new" },
    ]);
    await act(async () =>
      resolvers[1]([
        { status: "hit", reference: "/store/nope", title: "late", mtime: 9 },
        { status: "hit", reference: "/store/new", title: "newest", mtime: 9 },
      ]),
    );
    expect(api.entries.size).toBe(3);
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
      true,
    );
    expect(before.status).toBe("nothing-to-read");

    // The rescan lands the row: revision bump, re-ask, a titled hit.
    revision += 1;
    await rerender();
    await act(async () =>
      resolvers[1]([
        { status: "hit", reference: "/store/s-1", title: "fix the auth bug", mtime: 9 },
      ]),
    );
    const after = joinJournalRow(
      labelTitled,
      api.entries.get(rowKeyOf({ agent: "claude", sessionId: "s-1" })),
      "Claude Code",
      false,
      true,
    );
    expect(after.title).toBe("fix the auth bug");
    expect(after.read).toEqual({ source: "index", reference: "/store/s-1" });
    expect(after.status).toBeNull();
  });
});
