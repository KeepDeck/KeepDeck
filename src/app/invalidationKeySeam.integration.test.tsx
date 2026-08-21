// @vitest-environment happy-dom
/**
 * T6 of the characterization table — the KEY SEAM, end to end. The
 * manager writes the dropped keys and this consumer deletes by them
 * from a table filled through `rowKeyOf` — one spelling shared by
 * both ends. Two separate tests — "the manager emitted a set" and
 * "the hook deletes a hand-built set" — prove nothing about the SEAM:
 * if a second pen ever appears on either end, the deletion misses in
 * silence while every unit test stays green. This test wires the
 * REAL manager to the REAL hook exactly as the production seam does
 * (useSessionsBrowser's useBrowserSharedSeam: useSyncExternalStore
 * over the manager's snapshot, its three fields into
 * useJournalEnrichment) and lets a scan's dropped key travel the
 * whole wire.
 *
 * Doubled modules sit at the chain's causal ends only: the scan
 * engine (historyScan — what the owner decides over) and the lookup
 * port (ipc/history — the join's ask). Between them everything is
 * production code.
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionIndexManager } from "./sessionIndexManager";
import { useJournalEnrichment } from "./useJournalEnrichment";
import { rowKeyOf } from "../domain/journal/sessionRow";
import type { ScanReport } from "./historyScan";
import type { SessionIndexManager } from "./sessionIndexManager";
import type { AgentHistory } from "@keepdeck/plugin-api";

const scans = vi.hoisted(() => ({
  scanAgentHistories: vi.fn<
    (...args: unknown[]) => Promise<ScanReport>
  >(),
}));
const ipc = vi.hoisted(() => ({
  indexLookup: vi.fn<
    (...args: unknown[]) => Promise<unknown[]>
  >(),
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  describeError: (e: unknown) => String(e),
}));

vi.mock("./historyScan", () => ({
  scanAgentHistories: scans.scanAgentHistories,
}));
vi.mock("../ipc/history", () => ({
  indexLookup: ipc.indexLookup,
}));
vi.mock("../ipc/log", () => ({
  log: ipc.log,
  describeError: ipc.describeError,
}));

/** The hook's answer side as the index's CURRENT truth — the lookup
 * double answers from it, so a key the scan DROPS answers `absent`
 * on the next ask: that re-ask is itself the deletion's visible
 * trace (a `hit` is never re-asked, so a purge that missed would
 * leave the hit standing forever). */
type IndexAnswer = {
  agent: string;
  sessionId: string;
  status: "hit" | "absent";
  reference: string;
  title: string | null;
  mtime: number;
};
const indexTruth = new Map<string, IndexAnswer>();
ipc.indexLookup.mockImplementation((...args: unknown[]) =>
  Promise.resolve(
    (args[0] as { agent: string; sessionId: string }[]).map((asked) => {
      const answer = indexTruth.get(rowKeyOf(asked));
      return answer ?? { ...asked, status: "absent" };
    }),
  ),
);

let manager: SessionIndexManager;
let api: ReturnType<typeof useJournalEnrichment>;
let root: Root | null = null;

/** The production wiring, verbatim: the manager's snapshot through
 * useSyncExternalStore, its three fields into the real hook. */
function Probe() {
  const store = useSyncExternalStoreRef();
  api = useJournalEnrichment(
    store.revision,
    store.scanning,
    store.invalidated,
  );
  return null;
}

// useSyncExternalStore imported lazily via React to keep the mock
// block above hoisted first.
import { useSyncExternalStore } from "react";
function useSyncExternalStoreRef() {
  return useSyncExternalStore(manager.subscribe, manager.snapshot);
}

const registry = () => ({
  list: () => [
    { entry: { id: "claude", history: {} as AgentHistory } },
  ],
  subscribe: () => () => {},
});

describe("invalidation key seam (T6, end to end)", () => {
  beforeEach(() => {
    indexTruth.clear();
    scans.scanAgentHistories.mockReset();
    ipc.indexLookup.mockClear();
    for (const id of ["s-keep", "s-doom"]) {
      indexTruth.set(`claude:${id}`, {
        agent: "claude",
        sessionId: id,
        reference: `/store/${id}`,
        title: `title ${id}`,
        mtime: 42,
        status: "hit",
      });
    }
    manager = createSessionIndexManager(registry());
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    manager.dispose();
  });

  it("keys the manager DROPS really delete the consumer's records — both pens on one wire", async () => {
    let resolveScan: (r: ScanReport) => void = () => {};
    scans.scanAgentHistories.mockImplementation(
      () =>
        new Promise<ScanReport>((res) => {
          resolveScan = res;
        }),
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Probe));
    });

    // Both keys are declared and answered as hits — the records the
    // drop will take away exist BY MATERIAL first.
    await act(async () => {
      api.declare([
        { agent: "claude", sessionId: "s-keep" },
        { agent: "claude", sessionId: "s-doom" },
      ]);
    });
    manager.ensureFresh();
    await act(async () => {});
    expect(api.entries.get("claude:s-keep")?.kind).toBe("hit");
    expect(api.entries.get("claude:s-doom")?.kind).toBe("hit");
    expect(ipc.indexLookup).toHaveBeenCalledTimes(1);

    // The scan settles with ONE dropped key — the manager's own pen
    // writes it into the snapshot (positive partner: the event
    // happened, by material, in the manager's OWN spelling — this
    // assert must not carry the consumer's pen, or it would hide the
    // very divergence the test exists to catch). The scan is also
    // what removes the key FROM the index itself: the double's truth
    // drops it with the settle, so the next ask honestly answers
    // absent.
    await act(async () => {
      indexTruth.delete("claude:s-doom");
      resolveScan({
        dropped: [{ agent: "claude", sessionId: "s-doom" }],
      });
    });
    await act(async () => {});
    const emitted = manager.snapshot().invalidated;
    expect(emitted.size).toBe(1);
    expect([...emitted][0].endsWith("s-doom")).toBe(true);

    // THE SEAM: the purge deleted the record, and the proof is
    // behavioral — the key is re-asked (hits never are) and the
    // index's post-drop truth answers absent. A diverged pen leaves
    // the stale hit standing forever: this line is where it goes red.
    expect(api.entries.get("claude:s-doom")?.kind).toBe("absent");
    // The re-ask covered exactly the dropped key.
    expect(ipc.indexLookup.mock.calls[1][0]).toEqual([
      { agent: "claude", sessionId: "s-doom" },
    ]);
    // The survivor keeps ITS OWN answer — the purge took one key,
    // not the table.
    expect(api.entries.get("claude:s-keep")?.kind).toBe("hit");
  });
});
