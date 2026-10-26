import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
