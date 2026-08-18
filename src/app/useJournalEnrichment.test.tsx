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
import type { RowKey } from "./useJournalEnrichment";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** A keyed answer fixture: every answer carries the key it answers —
 * hit, absent, foreign alike. */
const ans = (
  key: RowKey,
  status: "hit" | "absent",
  over: { reference?: string; title?: string | null; mtime?: number } = {},
): IndexLookupAnswer =>
  status === "hit"
    ? {
        agent: key.agent,
        sessionId: key.sessionId,
        status: "hit",
        reference: over.reference ?? `/store/${key.sessionId}`,
        title: over.title ?? null,
        mtime: over.mtime ?? 9,
      }
    : { agent: key.agent, sessionId: key.sessionId, status: "absent" };

/** The hook under whatever (revision, scanning, invalidated) the test
 * currently drives. */
let api: ReturnType<typeof useJournalEnrichment>;

function Probe({
  revision,
  scanning,
  invalidated,
}: {
  revision: number;
  scanning: boolean;
  invalidated?: ReadonlySet<string>;
}) {
  api = useJournalEnrichment(revision, scanning, invalidated);
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

  it("a RACING landing must not resurrect a pruned session: hit survives the invalidation it flew through", async () => {
    // The mid-flight race: a key whose last answer was NOT a hit goes
    // into an ask; while it flies, a scan prunes that very session and
    // publishes the invalidation. The stale answer then lands saying
    // "hit" — the map must NOT contain it, the follow-up ask must TAKE
    // the key, and its absence must win. Red on the racing code: the
    // landing wrote the hit unconditionally and the follow-up skipped
    // it as "already a hit" — a false "the index knows this session"
    // forever, despite a PROVEN deletion.
    let invalidated: ReadonlySet<string> = new Set();
    const render = () =>
      act(async () =>
        root.render(createElement(Probe, { revision, scanning, invalidated })),
      );
    revision = 1;
    await render();
    act(() => api.declare([KEYS.unknown]));
    await act(async () => {});
    // The ask is in flight (resolver 0 pending) — key's last answer was
    // undefined, so it IS in the ask.

    // The scan settles mid-flight: the session is pruned, the
    // invalidation set gains a NEW identity.
    revision += 1;
    invalidated = new Set([rowKeyOf(KEYS.unknown)]);
    await render();

    // The stale answer NOW lands as a hit.
    await act(async () =>
      resolvers[0]([ans(KEYS.unknown, "hit", { title: "stale" })]),
    );
    // THE assertion: the resurrected hit must not stand.
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).not.toMatchObject({ kind: "hit" });

    // And the follow-up ask must carry the key (not skip it as a hit);
    // its absence then wins.
    const lastCall =
      ipc.indexLookup.mock.calls[ipc.indexLookup.mock.calls.length - 1];
    expect(lastCall[0]).toEqual([KEYS.unknown]);
    await act(async () => resolvers[1]([ans(KEYS.unknown, "absent")]));
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).toEqual({ kind: "absent" });
  });

  it("INVARIANT 1: answers arriving in a SHUFFLED order land on their own keys — never crossed", async () => {
    // Two keys, both non-hits, one ask; the ask is answered with the
    // answers deliberately SWAPPED relative to the request order. On
    // positional code the entries cross wires — each key receives the
    // other's truth. Keyed answers make the swap a no-op.
    let invalidated: ReadonlySet<string> = new Set();
    const render = () =>
      act(async () =>
        root.render(createElement(Probe, { revision, scanning, invalidated })),
      );
    revision = 1;
    await render();
    act(() => api.declare([KEYS.own, KEYS.unknown]));
    await act(async () => {});
    // Answers SWAPPED: unknown's absent first, own's hit second.
    await act(async () =>
      resolvers[0]([
        ans(KEYS.unknown, "absent"),
        ans(KEYS.own, "hit", { title: "mine" }),
      ]),
    );
    expect(api.entries.get(rowKeyOf(KEYS.own))).toMatchObject({
      kind: "hit",
      title: "mine",
    });
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).toEqual({ kind: "absent" });
  });

  it("INVARIANT 1: a racing landing drops exactly the invalidated keys — survivors keep THEIR answers, the dead stay dead", async () => {
    // THREE keys in one ask, the invalidated one in the MIDDLE — the
    // positional subtraction shifts answers left of every survivor past
    // it. Survivors must keep their OWN answers; the invalidated key
    // must not resurrect; the follow-up must take the dead key back.
    let invalidated: ReadonlySet<string> = new Set();
    const render = () =>
      act(async () =>
        root.render(createElement(Probe, { revision, scanning, invalidated })),
      );
    revision = 1;
    await render();
    act(() => api.declare([KEYS.own, KEYS.foreign, KEYS.unknown]));
    await act(async () => {});

    // The scan settles mid-flight: FOREIGN dies (the middle key).
    revision += 1;
    invalidated = new Set([rowKeyOf(KEYS.foreign)]);
    await render();

    // The stale answer lands — own=hit, foreign=hit (a lie now),
    // unknown=absent, in ASK order.
    await act(async () =>
      resolvers[0]([
        ans(KEYS.own, "hit", { title: "mine" }),
        ans(KEYS.foreign, "hit", { title: "resurrected", reference: "/store/kimi-9" }),
        ans(KEYS.unknown, "absent"),
      ]),
    );
    // The survivor BEFORE the dropped position keeps ITS answer...
    expect(api.entries.get(rowKeyOf(KEYS.own))).toMatchObject({
      kind: "hit",
      title: "mine",
    });
    // ...the dead one does not resurrect...
    expect(api.entries.get(rowKeyOf(KEYS.foreign))).not.toMatchObject({
      kind: "hit",
    });
    // ...and the survivor AFTER the dropped position keeps ITS answer —
    // the positional shift would hand it the dead key's lie.
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).toEqual({ kind: "absent" });

    // The follow-up re-covers the dead key (and whatever else the settle
    // re-owes — the survivors' answers under the new revision; the dead
    // one is IN, which is the point).
    const lastCall =
      ipc.indexLookup.mock.calls[ipc.indexLookup.mock.calls.length - 1];
    expect(lastCall[0]).toEqual(
      expect.arrayContaining([KEYS.foreign]),
    );
    await act(async () =>
      resolvers[1]([
        ans(KEYS.foreign, "hit", { title: "born again", reference: "/store/kimi-9" }),
      ]),
    );
    expect(api.entries.get(rowKeyOf(KEYS.foreign))).toMatchObject({
      kind: "hit",
      title: "born again",
    });
  });

  it("INVARIANT 2: a death in an EARLIER scan of the flight is still honored — not just the latest set", async () => {
    // Two scans settle while one ask flies. The key dies in the FIRST;
    // the second scan's invalidation set does NOT name it (replaced, not
    // accumulated). Identity-of-current-set comparison passes the stale
    // answer through — a generation check must reject it. Red on the
    // current code: only the latest set is consulted.
    let invalidated: ReadonlySet<string> = new Set();
    const render = () =>
      act(async () =>
        root.render(createElement(Probe, { revision, scanning, invalidated })),
      );
    revision = 1;
    await render();
    act(() => api.declare([KEYS.unknown]));
    await act(async () => {});

    // Scan 1 settles mid-flight: unknown dies.
    revision += 1;
    invalidated = new Set([rowKeyOf(KEYS.unknown)]);
    await render();

    // Scan 2 settles too — its set is empty (replaced): identity moved
    // again, and the death is no longer named by the CURRENT set.
    revision += 1;
    invalidated = new Set();
    await render();

    // The stale answer lands as a hit — flown before BOTH deaths.
    await act(async () =>
      resolvers[0]([ans(KEYS.unknown, "hit", { title: "stale" })]),
    );
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).not.toMatchObject({ kind: "hit" });
    // The key is still owed and re-asked.
    const lastCall =
      ipc.indexLookup.mock.calls[ipc.indexLookup.mock.calls.length - 1];
    expect(lastCall[0]).toEqual([KEYS.unknown]);
    await act(async () => resolvers[1]([ans(KEYS.unknown, "absent")]));
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).toEqual({ kind: "absent" });
  });

  it("a PRUNED key's hit is devalued — the file-erased verdict's missing half", async () => {
    // The full regression line: the session is known to the index (a
    // hit) → the file is erased while the app runs → the prune names the
    // key → the hit is purged and re-asked → the domain sees the absence.
    let invalidated: ReadonlySet<string> = new Set();
    const render = () =>
      act(async () =>
        root.render(createElement(Probe, { revision, scanning, invalidated })),
      );
    revision = 1;
    await render();
    act(() => api.declare([KEYS.own]));
    await act(async () => {});
    await act(async () =>
      resolvers[0]([ans(KEYS.own, "hit", { title: "known" })]),
    );
    expect(api.entries.get(rowKeyOf(KEYS.own))).toMatchObject({ kind: "hit" });
    expect(ipc.indexLookup).toHaveBeenCalledTimes(1);

    // The next settled scan pruned the session: a NEW invalidation
    // identity, same revision semantics as any settle.
    revision += 1;
    invalidated = new Set([rowKeyOf(KEYS.own)]);
    await render();
    // The hit is GONE from the table (not "still trusted"), and the key
    // went back into the ask.
    expect(api.entries.has(rowKeyOf(KEYS.own))).toBe(false);
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);
    expect(ipc.indexLookup).toHaveBeenLastCalledWith([KEYS.own]);
    // The index answers absence — the domain finally sees it.
    await act(async () => resolvers[1]([ans(KEYS.own, "absent")]));
    expect(api.entries.get(rowKeyOf(KEYS.own))).toEqual({ kind: "absent" });
  });

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
    await act(async () => resolvers[0]([ans(KEYS.unknown, "absent")]));
    expect(api.pending).toBe(false); // answered under the current revision

    revision += 1; // the scan settled — one publish, both fields
    await rerender();
    expect(api.pending).toBe(true); // the re-ask is owed/in flight

    // The re-ask lands ABSENT again under the new revision: a settled
    // verdict is still reachable — pending false exactly once the
    // CURRENT revision has answered.
    await act(async () => resolvers[1]([ans(KEYS.unknown, "absent")]));
    expect(api.pending).toBe(false);
    expect(api.entries.get(rowKeyOf(KEYS.unknown))).toEqual({ kind: "absent" });

    // And a hit landing under a bump ends the provisional state too —
    // a fresh key, since hits are never re-asked.
    act(() => api.declare([KEYS.own]));
    await act(async () => {});
    await act(async () =>
      resolvers[2]([ans(KEYS.own, "hit", { title: "late" })]),
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
      resolvers[0]([ans(KEYS.own, "hit", { title: null }), ans(KEYS.unknown, "absent")]),
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
        ans(KEYS.own, "hit", { title: "the real title" }),
        {
          agent: KEYS.foreign.agent,
          sessionId: KEYS.foreign.sessionId,
          status: "foreign",
          agents: ["kimi"],
        },
        ans(KEYS.unknown, "absent"),
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
      resolvers[0]([ans(KEYS.own, "hit", { title: null }), ans(KEYS.unknown, "absent")]),
    );

    revision += 1; // a scan batch landed
    await rerender();
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);
    expect(ipc.indexLookup).toHaveBeenLastCalledWith([KEYS.unknown]);

    // The batch delivered the previously-absent session: it turns hit.
    await act(async () =>
      resolvers[1]([ans(KEYS.unknown, "hit", { title: "late arrival", reference: "/store/nope" })]),
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
        {
          agent: KEYS.foreign.agent,
          sessionId: KEYS.foreign.sessionId,
          status: "foreign",
          agents: ["kimi"],
        },
        ans(KEYS.unknown, "absent"),
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
      resolvers[0]([ans(KEYS.own, "absent"), ans(KEYS.unknown, "absent")]),
    );
    expect(api.pending).toBe(true); // answered-under-older-revision holds

    // The catch-up fires ONCE, with the full still-owed set.
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);
    expect(ipc.indexLookup).toHaveBeenLastCalledWith([KEYS.own, KEYS.unknown]);
    // And it answers under the CURRENT revision: pending finally rests.
    await act(async () =>
      resolvers[1]([
        ans(KEYS.own, "hit", { title: "burst title" }),
        ans(KEYS.unknown, "absent"),
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
      resolvers[0]([ans(KEYS.own, "absent"), ans(KEYS.unknown, "absent")]),
    );
    revision += 1;
    await rerender();
    expect(ipc.indexLookup).toHaveBeenCalledTimes(2);
    await act(async () =>
      resolvers[1]([
        ans(KEYS.own, "hit", { title: "burst title" }),
        ans(KEYS.unknown, "absent"),
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
      resolvers[0]([ans(KEYS.own, "hit", { title: null }), ans(KEYS.unknown, "absent")]),
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
        ans(KEYS.unknown, "hit", { title: "late", reference: "/store/nope" }),
        ans({ agent: "codex", sessionId: "new" }, "hit", { title: "newest" }),
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
    await act(async () =>
      resolvers[0]([ans({ agent: "claude", sessionId: "s-1" }, "absent")]),
    );

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
        ans(
          { agent: "claude", sessionId: "s-1" },
          "hit",
          { title: "fix the auth bug" },
        ),
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
