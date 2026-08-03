import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckStore } from "./deckStore";
import type { PaneReportEvent } from "./verifiedPaneReports";
import { createVerifiedPaneReports } from "./verifiedPaneReports";
import { createPaneAttribution } from "./paneAttribution";

const stubs = vi.hoisted(() => ({
  peekPaneSpawnSpec: vi.fn(),
  paneSessionState: vi.fn(
    (): { kind: string; code?: number | null } => ({ kind: "live" }),
  ),
  warn: vi.fn(),
}));
vi.mock("./spawnSpecs", () => ({ peekPaneSpawnSpec: stubs.peekPaneSpawnSpec }));
vi.mock("./ptyManager", () => ({ paneSessionState: stubs.paneSessionState }));
vi.mock("../ipc/log", () => ({
  log: { warn: stubs.warn, info: vi.fn(), error: vi.fn() },
}));

/** A deck store holding exactly one workspace with the given panes, each
 * running claude — the agent a report has to claim to be believed. */
const deckWith = (...paneIds: string[]) =>
  ({
    getSnapshot: () => ({
      workspaces: [
        {
          id: "ws-1",
          panes: paneIds.map((id) => ({ id, agentType: "claude" })),
        },
      ],
    }),
    subscribe: () => () => {},
  }) as unknown as DeckStore;

/** The shape every lane carries: correlation plus the reporter's name. */
const fromClaude = (paneId: string, token = "tok"): PaneReportEvent => ({
  paneId,
  token,
  payload: { agent: "claude" },
});

describe("createVerifiedPaneReports", () => {
  let handler: ((report: PaneReportEvent) => void) | null;
  let unlisten: ReturnType<typeof vi.fn>;
  let apply: ReturnType<typeof vi.fn>;

  const subscribe = vi.fn(async (h: (report: PaneReportEvent) => void) => {
    handler = h;
    return unlisten as unknown as () => void;
  });

  const start = (
    deck: DeckStore,
    over: Partial<
      Parameters<typeof createVerifiedPaneReports>[2]
    > = {},
  ) =>
    createVerifiedPaneReports(
      deck,
      // The real rule over the same stubbed spawn cache the lane used to
      // read directly: what is under test is which reports survive it.
      createPaneAttribution({
        workspaces: () => deck.getSnapshot().workspaces,
        secretOf: (paneId) => stubs.peekPaneSpawnSpec(paneId)?.token,
      }),
      {
        label: "test report",
        subscribe,
        apply,
        ...over,
      },
    );

  beforeEach(() => {
    vi.clearAllMocks();
    handler = null;
    unlisten = vi.fn();
    apply = vi.fn();
    stubs.peekPaneSpawnSpec.mockReturnValue({ token: "tok" });
    stubs.paneSessionState.mockReturnValue({ kind: "live" });
  });

  /** The async subscribe resolves on a microtask; flush it. */
  const settle = () => Promise.resolve();

  it("applies a report that passes membership and token", async () => {
    start(deckWith("pane-1"));
    await settle();
    handler!({ paneId: "pane-1", token: "tok", payload: { agent: "claude" } });
    expect(apply).toHaveBeenCalledWith("pane-1", { agent: "claude" });
  });

  it("drops a report for a pane the deck no longer holds", async () => {
    start(deckWith("pane-1"));
    await settle();
    handler!(fromClaude("pane-9"));
    expect(apply).not.toHaveBeenCalled();
    expect(stubs.warn).toHaveBeenCalledWith(
      "web:bridge",
      expect.stringContaining("closed pane pane-9"),
    );
  });

  it("drops a report whose token does not match the spawn plan", async () => {
    start(deckWith("pane-1"));
    await settle();
    handler!(fromClaude("pane-1", "stale"));
    expect(apply).not.toHaveBeenCalled();
    // No cached plan at all (dropped on restart) refuses too.
    stubs.peekPaneSpawnSpec.mockReturnValue(undefined);
    handler!(fromClaude("pane-1"));
    expect(apply).not.toHaveBeenCalled();
  });

  it("drops a report from an agent this pane is not running", async () => {
    // The secret is inherited by every descendant of the pane's process, so
    // a nested CLI's reporter holds a VALID one. Dispatched by the agent it
    // names, its numbers would land on this pane — no rebinding needed.
    start(deckWith("pane-1"));
    await settle();
    handler!({
      paneId: "pane-1",
      token: "tok",
      payload: { agent: "kimi", statusline: {} },
    });
    expect(apply).not.toHaveBeenCalled();
    expect(stubs.warn).toHaveBeenCalledWith(
      "web:bridge",
      expect.stringContaining("from kimi"),
    );
  });

  it("drops a report that names no agent at all", async () => {
    start(deckWith("pane-1"));
    await settle();
    handler!({ paneId: "pane-1", token: "tok", payload: {} });
    expect(apply).not.toHaveBeenCalled();
    expect(stubs.warn).toHaveBeenCalledWith(
      "web:bridge",
      expect.stringContaining("unnamed agent"),
    );
  });

  it("requireLiveProcess drops reports from a dead process, allows a starting one", async () => {
    start(deckWith("pane-1"), { requireLiveProcess: true });
    await settle();
    stubs.paneSessionState.mockReturnValue({ kind: "exited", code: 1 });
    handler!(fromClaude("pane-1"));
    expect(apply).not.toHaveBeenCalled();
    expect(stubs.warn).toHaveBeenCalledWith(
      "web:bridge",
      expect.stringContaining("no live process (exited)"),
    );
    // A hook can beat the spawn promise's resolution — starting counts.
    stubs.paneSessionState.mockReturnValue({ kind: "starting" });
    handler!(fromClaude("pane-1"));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("without requireLiveProcess a dead process still reports (the usage lane)", async () => {
    start(deckWith("pane-1"));
    await settle();
    stubs.paneSessionState.mockReturnValue({ kind: "exited", code: 1 });
    handler!(fromClaude("pane-1"));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on dispose, and immediately when disposed mid-subscribe", async () => {
    const lane = start(deckWith("pane-1"));
    await settle();
    lane.dispose();
    expect(unlisten).toHaveBeenCalledTimes(1);
    // A report arriving after dispose is dropped even if the transport has
    // not detached yet.
    handler!(fromClaude("pane-1"));
    expect(apply).not.toHaveBeenCalled();

    // Dispose BEFORE the subscribe promise resolves: the late unlisten runs.
    let resolve!: (u: () => void) => void;
    subscribe.mockImplementationOnce(
      () => new Promise<() => void>((r) => (resolve = r)),
    );
    const lateUnlisten = vi.fn();
    const early = start(deckWith("pane-1"));
    early.dispose();
    resolve(lateUnlisten as unknown as () => void);
    await Promise.resolve();
    expect(lateUnlisten).toHaveBeenCalledTimes(1);
  });
});
