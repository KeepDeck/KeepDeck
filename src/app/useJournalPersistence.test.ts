// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeJournalEvent } from "../domain/journal/persist";
import type { JournalEvent } from "../domain/journal";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { useJournalPersistence } from "./useJournalPersistence";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ipc = vi.hoisted(() => ({
  loadJournal: vi.fn<() => Promise<string[]>>(),
  appendJournal: vi.fn<(lines: string[]) => Promise<void>>(() => Promise.resolve()),
  compactJournal: vi.fn<(lines: string[]) => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("../ipc/journal", () => ipc);

const T = "2026-07-18T10:00:00.000Z";

const storedLine = (wsId: string, sessionId: string): string =>
  encodeJournalEvent({
    e: "bound",
    v: 1,
    wsId,
    record: {
      agent: "claude",
      sessionId,
      cwd: "/repo",
      boundAt: T,
      paneId: "pane-1",
    },
  } satisfies JournalEvent);

let deck: Deck;

function Probe({ restoring, frozen }: { restoring: boolean; frozen: boolean }) {
  deck = useDeck();
  useJournalPersistence(deck, restoring, frozen);
  return null;
}

const addWorkspace = (id: string) =>
  deck.createWorkspace({
    id,
    instance: createWorkspaceInstance(),
    name: id,
    cwd: "/repo",
    worktreeBaseDir: null,
    panes: [{ id: `${id}-pane-1`, agentType: "claude" }],
  });

/** Hydrate the deck with one workspace, as a real boot restore would —
 * journal keys only attach to RESTORED workspace ids. */
const restoreWorkspace = (id: string) =>
  deck.hydrate({
    workspaces: [
      {
        id,
        instance: createWorkspaceInstance(),
        name: id,
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: `${id}-pane-1`, agentType: "claude" }],
      },
    ],
    activeId: id,
    viewByWs: {},
    journal: { records: {}, tail: [] },
  });

describe("useJournalPersistence", () => {
  let root: Root;

  beforeEach(() => {
    ipc.loadJournal.mockReset();
    ipc.appendJournal.mockClear();
    ipc.appendJournal.mockImplementation(() => Promise.resolve());
    ipc.compactJournal.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const mount = async (props: { restoring: boolean; frozen: boolean }) => {
    await act(async () => root.render(createElement(Probe, props)));
    await act(async () => {});
  };

  it("hydrates after the deck restored: demotes live records, prunes orphans, appends the convergence events", async () => {
    ipc.loadJournal.mockResolvedValue([
      storedLine("ws-1", "s-old"),
      storedLine("ws-ghost", "s-orphan"),
    ]);
    await mount({ restoring: true, frozen: false });
    act(() => {
      restoreWorkspace("ws-1");
    });
    expect(deck.journal.records).toEqual({}); // not hydrated while restoring

    await mount({ restoring: false, frozen: false });

    expect(deck.journal.records["ws-1"]).toHaveLength(1);
    expect(deck.journal.records["ws-1"][0]).toMatchObject({
      sessionId: "s-old",
      state: "closed", // demoted: its process died with the previous run
    });
    expect("ws-ghost" in deck.journal.records).toBe(false);
    // The convergence events (orphan prune + demotion seal) were appended
    // and the outbox drained.
    await act(async () => {});
    expect(deck.journal.tail).toEqual([]);
    const appended = ipc.appendJournal.mock.calls.flat(2).join("\n");
    expect(appended).toContain('"wsDeleted"');
    expect(appended).toContain('"sealed"');
  });

  it("appends a binding's event the moment it lands and trims the outbox", async () => {
    ipc.loadJournal.mockResolvedValue([]);
    await mount({ restoring: false, frozen: false });
    act(() => {
      addWorkspace("ws-1");
    });
    ipc.appendJournal.mockClear();

    act(() =>
      deck.setPaneSession("ws-1", "ws-1-pane-1", { id: "s-new", boundAt: T }),
    );
    await act(async () => {});

    expect(ipc.appendJournal).toHaveBeenCalledTimes(1);
    expect(ipc.appendJournal.mock.calls[0][0][0]).toContain('"s-new"');
    expect(deck.journal.tail).toEqual([]);
    expect(deck.journal.records["ws-1"][0]).toMatchObject({
      sessionId: "s-new",
      state: "live",
    });
  });

  it("a failed append keeps the events queued for the next try", async () => {
    ipc.loadJournal.mockResolvedValue([]);
    await mount({ restoring: false, frozen: false });
    act(() => {
      addWorkspace("ws-1");
    });
    ipc.appendJournal.mockRejectedValueOnce(new Error("disk full"));

    act(() =>
      deck.setPaneSession("ws-1", "ws-1-pane-1", { id: "s-new", boundAt: T }),
    );
    await act(async () => {});
    expect(deck.journal.tail).toHaveLength(1);

    // The next event retries the whole queue in order.
    act(() => deck.closeAgent("ws-1", "ws-1-pane-1"));
    await act(async () => {});
    expect(deck.journal.tail).toEqual([]);
    const calls = ipc.appendJournal.mock.calls;
    expect(calls[calls.length - 1][0]).toHaveLength(2);
  });

  it("a failed append re-arms itself on a timer — an idle quit must not lose the tail", async () => {
    vi.useFakeTimers();
    try {
      ipc.loadJournal.mockResolvedValue([]);
      await mount({ restoring: false, frozen: false });
      act(() => {
        addWorkspace("ws-1");
      });
      ipc.appendJournal.mockRejectedValueOnce(new Error("disk full"));

      act(() =>
        deck.setPaneSession("ws-1", "ws-1-pane-1", { id: "s-new", boundAt: T }),
      );
      await act(async () => {});
      expect(deck.journal.tail).toHaveLength(1); // the flight failed

      // NO further journal events happen — only the retry timer fires.
      await act(async () => {
        vi.advanceTimersByTime(2100);
      });
      await act(async () => {});
      expect(deck.journal.tail).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("frozen: never hydrates and never appends — the parked deck must not prune history", async () => {
    ipc.loadJournal.mockResolvedValue([storedLine("ws-1", "s-old")]);
    await mount({ restoring: false, frozen: true });

    expect(deck.journal.records).toEqual({});
    expect(ipc.appendJournal).not.toHaveBeenCalled();
    expect(ipc.compactJournal).not.toHaveBeenCalled();
  });

  it("compacts a long, mostly-garbage log before hydrating", async () => {
    ipc.loadJournal.mockResolvedValue([
      storedLine("ws-1", "s-old"),
      ...Array.from({ length: 800 }, () => "{torn"),
    ]);
    await mount({ restoring: false, frozen: false });
    await act(async () => {});

    expect(ipc.compactJournal).toHaveBeenCalledTimes(1);
    // The rewrite is the folded state — one record line, no garbage.
    expect(ipc.compactJournal.mock.calls[0][0]).toHaveLength(1);
    expect(ipc.compactJournal.mock.calls[0][0][0]).toContain('"record"');
  });
});
