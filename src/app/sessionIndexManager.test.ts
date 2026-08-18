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

const scans = vi.hoisted(() => ({
  scanAgentHistories: vi.fn(
    (..._args: unknown[]) => Promise.resolve(new Map<string, string>()),
  ),
}));
vi.mock("./historyScan", () => scans);

/** A scan that hangs until `finish()` — for chaining/dedup tests. */
function hangingScan() {
  let finish!: () => void;
  scans.scanAgentHistories.mockImplementationOnce(
    () =>
      new Promise<Map<string, string>>((resolve) => {
        finish = () => resolve(new Map());
      }),
  );
  return () => finish();
}

/** A scan that reports one landed batch mid-flight, then settles with
 * every source's walk complete (the certified outcome). */
function batchyScan() {
  let finish!: () => void;
  scans.scanAgentHistories.mockImplementationOnce(
    (...args: unknown[]) =>
      new Promise<Map<string, string>>((resolve) => {
        (args[2] as () => void)(); // a batch landed
        const sources = args[0] as Array<{ agentId: string }>;
        finish = () =>
          resolve(
            new Map(sources.map((s) => [s.agentId, "complete"] as const)),
          );
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
  scans.scanAgentHistories.mockResolvedValue(new Map<string, string>());
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
      scannedAgents: new Set(),
    });
    expect(listener).toHaveBeenCalledTimes(2);

    settle();
    await flush();
    // The settle publishes the scan's participants — claude and codex
    // have history, kimi is not a source — the file-erased verdict's
    // precondition.
    expect(manager.snapshot()).toEqual({
      scanning: false,
      revision: 2,
      scannedAgents: new Set(["claude", "codex"]),
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

describe("sessionIndexManager scan proof (E1 regressions)", () => {
  /** The per-agent outcomes the scanner contract carries: complete,
   * partial, failed. Red on the current code: it replaces the set with
   * every source unconditionally and reads no outcomes at all. */
  const outcomes = (entries: Array<[string, string]>) => new Map(entries);

  it("a REFUSED pass keeps the previous proof — tried is not looked", async () => {
    const { registry } = fakeRegistry(CONTRIBUTIONS);
    const manager = createSessionIndexManager(registry);
    scans.scanAgentHistories.mockImplementationOnce(async () =>
      outcomes([
        ["claude", "complete"],
        ["codex", "complete"],
      ]),
    );
    manager.ensureFresh();
    await flush();
    expect([...manager.snapshot().scannedAgents].sort()).toEqual([
      "claude",
      "codex",
    ]);

    // The next pass refuses outright — its agents were not walked to a
    // conclusion, so the previous proofs must stand untouched.
    scans.scanAgentHistories.mockImplementationOnce(() =>
      Promise.reject(new Error("bridge gone")),
    );
    manager.ensureFresh("claude");
    await flush();
    expect([...manager.snapshot().scannedAgents].sort()).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("a SWALLOWED per-agent refusal certifies no one for that agent", async () => {
    const { registry } = fakeRegistry(CONTRIBUTIONS);
    const manager = createSessionIndexManager(registry);
    // The scan RESOLVES (the outer promise never sees the failure), but
    // codex's own walk refused — the contract says so.
    scans.scanAgentHistories.mockImplementationOnce(async () =>
      outcomes([
        ["claude", "complete"],
        ["codex", "failed"],
      ]),
    );
    manager.ensureFresh();
    await flush();
    expect([...manager.snapshot().scannedAgents].sort()).toEqual(["claude"]);
  });

  it("a NARROW success keeps the others' proofs", async () => {
    const { registry } = fakeRegistry(CONTRIBUTIONS);
    const manager = createSessionIndexManager(registry);
    scans.scanAgentHistories.mockImplementationOnce(async () =>
      outcomes([
        ["claude", "complete"],
        ["codex", "complete"],
      ]),
    );
    manager.ensureFresh();
    await flush();

    // A narrow pass learned about codex only; claude's proof came from an
    // earlier complete walk and nothing since contradicted it.
    scans.scanAgentHistories.mockImplementationOnce(async () =>
      outcomes([["codex", "complete"]]),
    );
    manager.ensureFresh("codex");
    await flush();
    expect([...manager.snapshot().scannedAgents].sort()).toEqual([
      "claude",
      "codex",
    ]);
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
