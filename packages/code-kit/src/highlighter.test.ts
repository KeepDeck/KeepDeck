import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isHighlightRequest } from "./protocol";

/** A stand-in for the inline worker: records what the client posts and lets
 * the test answer — the engine itself has its own suite (engine.test.ts). */
class FakeWorker extends EventTarget {
  static spawned: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  constructor() {
    super();
    FakeWorker.spawned.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  fail(message: string): void {
    const event = new Event("error");
    Object.defineProperty(event, "message", { value: message });
    this.dispatchEvent(event);
  }
}

vi.mock("./worker?worker&inline", () => ({ default: FakeWorker }));

/** A fresh client per test: the worker and what waits on it are module state. */
async function load() {
  vi.resetModules();
  return import("./highlighter");
}

/** The id of the last tokenize `worker` was asked. */
function lastTokenizeId(worker: FakeWorker): number {
  const requests = worker.posted.filter(isHighlightRequest);
  const request = requests[requests.length - 1];
  if (request?.kind !== "tokenize") throw new Error("no tokenize was posted");
  return request.id;
}

function only(): FakeWorker {
  expect(FakeWorker.spawned).toHaveLength(1);
  return FakeWorker.spawned[0];
}

describe("the highlight client", () => {
  beforeEach(() => {
    FakeWorker.spawned = [];
    vi.stubGlobal("Worker", FakeWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the worker and resolves with its lines, pairing replies by id", async () => {
    const { tokenizeLines } = await load();
    const first = tokenizeLines("a", "typescript");
    const second = tokenizeLines("b", "rust");
    const worker = only();
    expect(worker.posted).toEqual([
      { kind: "tokenize", id: 0, text: "a", lang: "typescript" },
      { kind: "tokenize", id: 1, text: "b", lang: "rust" },
    ]);
    worker.reply({ id: 1, lines: [[{ text: "b", color: "#fff" }]] });
    worker.reply({ id: 0, lines: null });
    await expect(second).resolves.toEqual([[{ text: "b", color: "#fff" }]]);
    await expect(first).resolves.toBeNull();
  });

  it("rejects on an engine failure and ignores a reply it cannot read", async () => {
    const { tokenizeLines } = await load();
    const request = tokenizeLines("a", "typescript");
    const worker = only();
    worker.reply({ id: 0, lines: [[{ text: 1 }]] });
    worker.reply("noise");
    worker.reply({ id: 0, error: "grammar exploded" });
    await expect(request).rejects.toThrow("grammar exploded");
  });

  it("drops a failed worker with everything waiting on it, and spawns a fresh one next time", async () => {
    const { tokenizeLines } = await load();
    const waiting = tokenizeLines("a", "typescript");
    const failed = only();
    failed.fail("out of memory");
    await expect(waiting).rejects.toThrow("highlight worker failed: out of memory");
    expect(failed.terminated).toBe(true);

    void tokenizeLines("b", "typescript");
    expect(FakeWorker.spawned).toHaveLength(2);
    expect(FakeWorker.spawned[1].posted).toEqual([
      { kind: "tokenize", id: 1, text: "b", lang: "typescript" },
    ]);
  });

  it("drops a worker that leaves a request unanswered past the deadline", async () => {
    vi.useFakeTimers();
    try {
      const { tokenizeLines, REPLY_DEADLINE_MS } = await load();
      const stuck = tokenizeLines("a", "typescript");
      const settled = expect(stuck).rejects.toThrow("no answer in 30s");
      await vi.advanceTimersByTimeAsync(REPLY_DEADLINE_MS);
      await settled;
      expect(only().terminated).toBe(true);
      void tokenizeLines("b", "typescript");
      expect(FakeWorker.spawned).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an answer in time clears its deadline", async () => {
    vi.useFakeTimers();
    try {
      const { tokenizeLines, REPLY_DEADLINE_MS } = await load();
      const answered = tokenizeLines("a", "typescript");
      only().reply({ id: 0, lines: null });
      await expect(answered).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(REPLY_DEADLINE_MS * 2);
      expect(only().terminated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after failures in a row, and an answer between them resets the count", async () => {
    const { tokenizeLines, MAX_FAILURES } = await load();
    // Two failures, then an answer, then MAX_FAILURES - 1 more: still alive.
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      const request = tokenizeLines("a", "typescript");
      FakeWorker.spawned[FakeWorker.spawned.length - 1].fail("boom");
      await expect(request).rejects.toThrow("boom");
    }
    const answered = tokenizeLines("ok", "typescript");
    const live = FakeWorker.spawned[FakeWorker.spawned.length - 1];
    live.reply({ id: lastTokenizeId(live), lines: null });
    await expect(answered).resolves.toBeNull();
    for (let i = 0; i < MAX_FAILURES; i++) {
      const request = tokenizeLines("a", "typescript");
      FakeWorker.spawned[FakeWorker.spawned.length - 1].fail("boom");
      await expect(request).rejects.toThrow("boom");
    }
    // Now off for the session: plain, and no worker spawned.
    const spawned = FakeWorker.spawned.length;
    await expect(tokenizeLines("a", "typescript")).resolves.toBeNull();
    expect(FakeWorker.spawned).toHaveLength(spawned);
  });

  it("warms with a message, no reply expected", async () => {
    const { warmLanguage } = await load();
    warmLanguage(null);
    warmLanguage("cpp");
    expect(only().posted).toEqual([
      { kind: "warm", lang: null },
      { kind: "warm", lang: "cpp" },
    ]);
  });

  it("renders plain where there is no worker to ask", async () => {
    vi.stubGlobal("Worker", undefined);
    const { tokenizeLines, warmLanguage } = await load();
    await expect(tokenizeLines("a", "typescript")).resolves.toBeNull();
    warmLanguage("cpp");
    expect(FakeWorker.spawned).toEqual([]);
  });
});
