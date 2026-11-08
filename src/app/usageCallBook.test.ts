import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageCall } from "@keepdeck/plugin-api";
import type { UsageCallBatch } from "../domain/usage/history/capture";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { createDeckActions, type DeckActions } from "./deckActions";
import { createDeckStore } from "./deckStore";
import type { AcceptedBinding } from "./sessionBinding";
import { createUsageSightings } from "./usageSightings";

const log = vi.hoisted(() => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("../ipc/log", () => ({ log }));
import { BOOK_DELAY_MS, createUsageCallBook } from "./usageCallBook";

const BOUND_AT = "2026-11-08T09:00:00.000Z";

const call = (id: string): UsageCall => ({
  id,
  at: 10,
  provider: "anthropic",
  model: "claude-opus-5-5",
  tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
});

describe("usage call book", () => {
  let deck: DeckActions;
  let clock: number;
  let announce: (bound: AcceptedBinding) => void;
  let booked: UsageCallBatch[];
  let book: ReturnType<typeof vi.fn<(batch: UsageCallBatch) => Promise<void>>>;

  const setup = () => {
    const store = createDeckStore();
    deck = createDeckActions(store);
    deck.createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "Deck",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        { id: "pane-1", agentType: "claude", name: "lead", session: { id: "s-1", boundAt: BOUND_AT } },
        { id: "pane-2", agentType: "codex" },
      ],
    });
    return createUsageCallBook(
      {
        deck: store,
        bindings: {
          subscribe: (listener) => {
            announce = listener;
            return () => {};
          },
        },
        sightings: createUsageSightings(() => clock),
      },
      { book },
    );
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000;
    booked = [];
    book = vi.fn(async (batch: UsageCallBatch) => {
      booked.push(batch);
    });
    log.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("books a pane's calls as one batch, under its session and place, once the burst is over", () => {
    const calls = setup();
    calls.book("pane-1", [call("a")]);
    calls.book("pane-1", [call("b"), call("c")]);
    expect(book).not.toHaveBeenCalled();

    vi.advanceTimersByTime(BOOK_DELAY_MS);
    expect(booked).toEqual([
      {
        agent: "claude",
        sessionId: "s-1",
        firstSeen: 1_000,
        place: {
          workspaceId: "ws-1",
          workspaceName: "Deck",
          workspaceCwd: "/repo",
          paneId: "pane-1",
          paneName: "lead",
        },
        calls: [call("a"), call("b"), call("c")],
      },
    ]);
    calls.dispose();
  });

  it("dates the session from when the deck accepted it, not from its first call", () => {
    const calls = setup();
    announce({ paneId: "pane-2", sessionId: "s-2", token: "t" });
    deck.setPaneSession("ws-1", "pane-2", { id: "s-2", boundAt: BOUND_AT });
    clock = 5_000;
    calls.book("pane-2", [call("x")]);
    vi.advanceTimersByTime(BOOK_DELAY_MS);
    expect(booked[0]).toMatchObject({ sessionId: "s-2", firstSeen: 1_000 });
    calls.dispose();
  });

  it("keeps the calls of a session the pane left under that session", () => {
    const calls = setup();
    calls.book("pane-1", [call("old")]);
    deck.setPaneSession("ws-1", "pane-1", { id: "s-9", boundAt: BOUND_AT });
    clock = 3_000;
    calls.book("pane-1", [call("new")]);
    vi.advanceTimersByTime(BOOK_DELAY_MS);
    expect(booked.map(({ sessionId, firstSeen, calls: sent }) => [sessionId, firstSeen, sent.map((c) => c.id)])).toEqual([
      ["s-1", 1_000, ["old"]],
      ["s-9", 3_000, ["new"]],
    ]);
    calls.dispose();
  });

  it("books nothing for a pane with no session, or one that left the deck", () => {
    const calls = setup();
    calls.book("pane-2", [call("x")]);
    calls.book("pane-gone", [call("y")]);
    calls.book("pane-1", []);
    vi.advanceTimersByTime(BOOK_DELAY_MS);
    expect(book).not.toHaveBeenCalled();
    calls.dispose();
  });

  it("says when a booking failed, and books the next one", async () => {
    const calls = setup();
    book.mockRejectedValueOnce(new Error("store busy"));
    calls.book("pane-1", [call("a")]);
    await vi.advanceTimersByTimeAsync(BOOK_DELAY_MS);
    expect(log.warn).toHaveBeenCalledTimes(1);
    calls.book("pane-1", [call("b")]);
    await vi.advanceTimersByTimeAsync(BOOK_DELAY_MS);
    expect(booked.map((batch) => batch.calls[0]?.id)).toEqual(["b"]);
    calls.dispose();
  });

  it("books what is waiting when it is disposed, and nothing after", () => {
    const calls = setup();
    calls.book("pane-1", [call("a")]);
    calls.dispose();
    expect(booked).toHaveLength(1);
    calls.book("pane-1", [call("b")]);
    vi.advanceTimersByTime(BOOK_DELAY_MS);
    expect(booked).toHaveLength(1);
  });
});
