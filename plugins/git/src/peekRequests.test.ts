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

const worktree = (path: string): PeekRequest => ({
  repo: "/repo",
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
    subscribePeekRequests(second);

    requestPeek(worktree("a.ts"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    takePeekRequest();
    requestPeek(worktree("b.ts"));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("notifies synchronously, so a listener can consume within the call", () => {
    const seen: (PeekRequest | null)[] = [];
    const stop = subscribePeekRequests(() => seen.push(takePeekRequest()));

    requestPeek(worktree("a.ts"));

    expect(seen).toEqual([worktree("a.ts")]);
    stop();
  });
});
