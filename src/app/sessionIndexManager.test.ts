import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionIndexManager } from "./sessionIndexManager";

/** A registry fake with a manual change signal: `set` swaps the
 * contributions and fires the subscribers, like the plugin registry does
 * when a plugin registers late. */
function fakeRegistry(contributions: Array<{ entry: { id: string; history?: object } }>) {
  const listeners = new Set<() => void>();
  let list = contributions;
  return {
    set(next: typeof contributions) {
      list = next;
      for (const listener of [...listeners]) listener();
    },
    registry: {
      list: () => list,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}

const CONTRIBUTIONS = [
  { entry: { id: "claude", history: { read: "claude-history" } } },
  { entry: { id: "codex", history: { read: "codex-history" } } },
  { entry: { id: "kimi" } }, // a history-less contribution is never a source
];

const scans = vi.hoisted(() => ({
  scanAgentHistories: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));
vi.mock("./historyScan", () => scans);

/** A scan that hangs until `finish()` — for chaining/dedup tests. */
function hangingScan() {
  let finish!: () => void;
  scans.scanAgentHistories.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  return () => finish();
}

/** A scan that reports one landed batch mid-flight, then settles. */
function batchyScan() {
  let finish!: () => void;
  scans.scanAgentHistories.mockImplementationOnce(
    (...args: unknown[]) =>
      new Promise<void>((resolve) => {
        (args[2] as () => void)(); // a batch landed
        finish = resolve;
      }),
  );
  return () => finish();
}

const sourcesOf = (call: number) =>
  scans.scanAgentHistories.mock.calls[call][0] as Array<{
    agentId: string;
    history: object;
  }>;

beforeEach(() => {
  scans.scanAgentHistories.mockReset();
  scans.scanAgentHistories.mockResolvedValue(undefined);
});

/** Let a settled scan's `.catch`/`.finally` chain (and the chained `run`
 * behind it) execute — a fixed number of microtask hops. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("sessionIndexManager scope", () => {
  it("ensureFresh() sweeps every history-bearing contribution", () => {
    const { registry } = fakeRegistry(CONTRIBUTIONS);
    const manager = createSessionIndexManager(registry);
    manager.ensureFresh();
    expect(scans.scanAgentHistories).toHaveBeenCalledTimes(1);
    expect(sourcesOf(0).map((s) => s.agentId)).toEqual(["claude", "codex"]);
  });

  it("ensureFresh(agent) indexes only that agent's store", () => {
    const { registry } = fakeRegistry(CONTRIBUTIONS);
    const manager = createSessionIndexManager(registry);
    manager.ensureFresh("codex");
    expect(sourcesOf(0)).toEqual([
      { agentId: "codex", history: { read: "codex-history" } },
    ]);
  });
});

describe("sessionIndexManager revision and scanning", () => {
  it("a landed batch bumps the revision while still scanning; settle bumps again", async () => {
    const { registry } = fakeRegistry(CONTRIBUTIONS);
    const manager = createSessionIndexManager(registry);
    const listener = vi.fn();
    manager.subscribe(listener);

    const settle = batchyScan();
    manager.ensureFresh();
    // scanning=true fired, then the batch tick bumped the revision.
    expect(manager.snapshot()).toEqual({ scanning: true, revision: 1 });
    expect(listener).toHaveBeenCalledTimes(2);

    settle();
    await flush();
    expect(manager.snapshot()).toEqual({ scanning: false, revision: 2 });
  });

  it("the snapshot is identity-stable between changes", async () => {
    const { registry } = fakeRegistry(CONTRIBUTIONS);
    const manager = createSessionIndexManager(registry);
    manager.ensureFresh(); // resolves immediately
    await flush();
    const settled = manager.snapshot();
    expect(manager.snapshot()).toBe(settled); // same object, no churn
  });
});

describe("sessionIndexManager dedup and chaining", () => {
  it("a need covered by the running pass is deduped, not queued", async () => {
    const { registry } = fakeRegistry(CONTRIBUTIONS);
    const manager = createSessionIndexManager(registry);
    const settle = hangingScan();

    manager.ensureFresh(); // full sweep, hangs
    manager.ensureFresh("claude"); // covered by the sweep
    manager.ensureFresh(); // identical to the running need
    settle();
    await flush();
    expect(scans.scanAgentHistories).toHaveBeenCalledTimes(1);
  });

  it("a need the running pass does not cover chains behind it", async () => {
    const { registry } = fakeRegistry(CONTRIBUTIONS);
    const manager = createSessionIndexManager(registry);
    const settleFirst = hangingScan();

    manager.ensureFresh("claude"); // narrow, hangs
    manager.ensureFresh("codex"); // different agent — not covered
    expect(scans.scanAgentHistories).toHaveBeenCalledTimes(1);

    settleFirst();
    await flush();
    expect(scans.scanAgentHistories).toHaveBeenCalledTimes(2);
    expect(sourcesOf(1).map((s) => s.agentId)).toEqual(["codex"]);
  });

  it("two different queued needs merge into one full sweep", async () => {
    const { registry } = fakeRegistry(CONTRIBUTIONS);
    const manager = createSessionIndexManager(registry);
    const settleFirst = hangingScan();

    manager.ensureFresh("claude");
    manager.ensureFresh("codex");
    manager.ensureFresh("kimi"); // no store — but the merge already widened
    settleFirst();
    await flush();
    expect(scans.scanAgentHistories).toHaveBeenCalledTimes(2);
    expect(sourcesOf(1).map((s) => s.agentId)).toEqual(["claude", "codex"]);
  });

  it("the chained pass runs even after the first FAILED", async () => {
    const { registry } = fakeRegistry(CONTRIBUTIONS);
    const manager = createSessionIndexManager(registry);
    scans.scanAgentHistories.mockImplementationOnce(() =>
      Promise.reject(new Error("boom")),
    );

    manager.ensureFresh("claude");
    manager.ensureFresh("codex");
    await flush();
    // The rejection is swallowed (logged); the queued pass still runs.
    expect(scans.scanAgentHistories).toHaveBeenCalledTimes(2);
    expect(sourcesOf(1).map((s) => s.agentId)).toEqual(["codex"]);
  });
});

describe("sessionIndexManager readiness", () => {
  it("a need over an empty registry hangs, then runs when sources appear", () => {
    const { registry, set } = fakeRegistry([]);
    const manager = createSessionIndexManager(registry);

    manager.ensureFresh("claude");
    expect(scans.scanAgentHistories).not.toHaveBeenCalled();

    set([{ entry: { id: "claude", history: { read: "claude-history" } } }]);
    expect(scans.scanAgentHistories).toHaveBeenCalledTimes(1);
    expect(sourcesOf(0).map((s) => s.agentId)).toEqual(["claude"]);
  });

  it("a registry change that adds no sources keeps the need hanging", () => {
    const { registry, set } = fakeRegistry([]);
    const manager = createSessionIndexManager(registry);

    manager.ensureFresh();
    set([{ entry: { id: "kimi" } }]); // registered, but no history surface
    expect(scans.scanAgentHistories).not.toHaveBeenCalled();
  });

  it("a need for an agent with no store resolves as a trivial pass", () => {
    const { registry } = fakeRegistry(CONTRIBUTIONS); // kimi has no history
    const manager = createSessionIndexManager(registry);
    manager.ensureFresh("kimi");
    // The registry HAS sources overall — this is "nothing to index", not
    // "not ready": an empty pass runs and settles.
    expect(scans.scanAgentHistories).toHaveBeenCalledTimes(1);
    expect(sourcesOf(0)).toEqual([]);
  });
});

describe("sessionIndexManager dispose", () => {
  it("stops the registry subscription and ignores later needs", () => {
    const { registry, set } = fakeRegistry([]);
    const manager = createSessionIndexManager(registry);
    manager.dispose();

    manager.ensureFresh();
    set([{ entry: { id: "claude", history: {} } }]);
    expect(scans.scanAgentHistories).not.toHaveBeenCalled();
  });
});
