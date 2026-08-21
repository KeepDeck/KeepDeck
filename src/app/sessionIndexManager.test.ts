import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHistory } from "@keepdeck/plugin-api";
import { createSessionIndexManager } from "./sessionIndexManager";

/** An opaque stand-in for a plugin history surface — the manager only
 * forwards it to scanAgentHistories (mocked), never calls it. */
const history = (marker: string) => ({ marker }) as unknown as AgentHistory;

/** A registry fake with a manual change signal: `set` swaps the
 * contributions and fires the subscribers, like the plugin registry does
 * when a plugin registers late. */
function fakeRegistry(
  contributions: Array<{ entry: { id: string; history?: AgentHistory } }>,
) {
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
  { entry: { id: "claude", history: history("claude") } },
  { entry: { id: "codex", history: history("codex") } },
  { entry: { id: "kimi" } }, // a history-less contribution is never a source
];

/** The scan report shape the manager consumes (loosely typed — the
 * manager is the contract's consumer, this is its stand-in). */
type Report = {
  dropped: Array<{ agent: string; sessionId: string }>;
};

const scans = vi.hoisted(() => ({
  scanAgentHistories: vi.fn(
    (..._args: unknown[]) =>
      Promise.resolve({ dropped: [] } as Report),
  ),
}));
vi.mock("./historyScan", () => scans);

/** A scan that hangs until `finish()` — for chaining/dedup tests. */
function hangingScan() {
  let finish!: () => void;
  scans.scanAgentHistories.mockImplementationOnce(
    () =>
      new Promise<Report>((resolve) => {
        finish = () => resolve({ dropped: [] });
      }),
  );
  return () => finish();
}

/** A scan that reports one landed batch mid-flight, then settles. */
function batchyScan() {
  let finish!: () => void;
  scans.scanAgentHistories.mockImplementationOnce(
    (...args: unknown[]) =>
      new Promise<Report>((resolve) => {
        (args[2] as () => void)(); // a batch landed
        finish = () => resolve({ dropped: [] });
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
  scans.scanAgentHistories.mockResolvedValue({ dropped: [] } as Report);
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
      { agentId: "codex", history: history("codex") },
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
    expect(manager.snapshot()).toEqual({
      scanning: true,
      revision: 1,
      invalidated: new Set(),
    });
    expect(listener).toHaveBeenCalledTimes(2);

    settle();
    await flush();
    expect(manager.snapshot()).toEqual({
      scanning: false,
      revision: 2,
      invalidated: new Set(),
    });
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

    set([{ entry: { id: "claude", history: history("claude") } }]);
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
describe("sessionIndexManager invalidation", () => {
  it("a pass whose PRUNE dropped sessions names them — the cache may devalue exactly those hits", async () => {
    // E2's red half, at the owner: the scan's report carries the keys
    // the index LOST, so the enrichment cache can drop exactly those
    // hits instead of trusting them forever. Absent this, a session
    // pruned while the app runs never reverts its hit to an absence.
    const { registry } = fakeRegistry(CONTRIBUTIONS);
    const manager = createSessionIndexManager(registry);
    scans.scanAgentHistories.mockImplementationOnce(async () => ({
      dropped: [{ agent: "claude", sessionId: "s-1" }],
    }));
    manager.ensureFresh();
    await flush();
    expect(manager.snapshot().invalidated?.has("claude:s-1")).toBe(true);
    // And a pass with NOTHING dropped keeps the previous invalidation
    // set's identity — no needless re-purge, no listener churn.
    const before = manager.snapshot().invalidated;
    scans.scanAgentHistories.mockImplementationOnce(async () => ({
      dropped: [],
    }));
    manager.ensureFresh("claude");
    await flush();
    expect(manager.snapshot().invalidated).toBe(before);
  });
});

describe("sessionIndexManager dispose", () => {
  it("stops the registry subscription and ignores later needs", () => {
    const { registry, set } = fakeRegistry([]);
    const manager = createSessionIndexManager(registry);
    manager.dispose();

    manager.ensureFresh();
    set([{ entry: { id: "claude", history: history("claude") } }]);
    expect(scans.scanAgentHistories).not.toHaveBeenCalled();
  });
});
