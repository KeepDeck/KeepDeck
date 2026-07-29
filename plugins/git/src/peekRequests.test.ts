import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestPeek,
  subscribePeekRequests,
  takePeekRequest,
  type PeekRequest,
} from "./peekRequests";
import type { ChangeRow } from "./domain/status";

const row = (path: string): ChangeRow => ({
  path,
  origPath: null,
  code: "M",
  kind: "unstaged",
});

const WS = { id: "ws-1", instance: "instance-1" };

const worktree = (path: string): PeekRequest => ({
  repo: "/repo",
  workspace: WS,
  kind: "worktree",
  row: row(path),
});

afterEach(() => {
  // The slot is module state — never let one test's request reach the next.
  takePeekRequest();
});

describe("peekRequests", () => {
  it("parks a request until it is taken, and answers null after", () => {
    requestPeek(worktree("a.ts"));

    expect(takePeekRequest()).toEqual(worktree("a.ts"));
    expect(takePeekRequest()).toBeNull();
  });

  it("keeps only the latest request — a second open replaces the first", () => {
    requestPeek(worktree("a.ts"));
    requestPeek(worktree("b.ts"));

    // Not a queue: the user asked for b.ts, and opening a.ts first would be
    // a diff nobody asked to see.
    expect(takePeekRequest()).toEqual(worktree("b.ts"));
    expect(takePeekRequest()).toBeNull();
  });

  it("wakes every live subscriber, and stops at unsubscribe", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribePeekRequests(first);
    // Captured, not discarded: the listener set is module state, so a
    // subscription this test leaks would go on answering every request the
    // REST of the file makes.
    const stopSecond = subscribePeekRequests(second);

    requestPeek(worktree("a.ts"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    takePeekRequest();
    requestPeek(worktree("b.ts"));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    stopSecond();
    takePeekRequest();
    requestPeek(worktree("c.ts"));
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("answers null when nothing was ever requested", () => {
    expect(takePeekRequest()).toBeNull();
  });

  it("survives a subscriber unsubscribing while it is being notified", () => {
    const late = vi.fn();
    let stopLate = () => {};
    // The producer is one synchronous loop; a listener that tears down during
    // it must not make the loop skip the ones behind it.
    const stopEarly = subscribePeekRequests(() => stopLate());
    stopLate = subscribePeekRequests(late);

    expect(() => requestPeek(worktree("a.ts"))).not.toThrow();
    // Removed mid-notification, but the snapshot the loop walks still
    // reaches it — the alternative is a request one listener silently eats.
    expect(late).toHaveBeenCalledTimes(1);

    takePeekRequest();
    requestPeek(worktree("b.ts"));
    expect(late).toHaveBeenCalledTimes(1);

    stopEarly();
  });

  it("notifies synchronously, so a listener can consume within the call", () => {
    const seen: (PeekRequest | null)[] = [];
    const stop = subscribePeekRequests(() => seen.push(takePeekRequest()));

    requestPeek(worktree("a.ts"));

    expect(seen).toEqual([worktree("a.ts")]);
    stop();
  });
});
