import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckStore } from "./deckStore";
import type { PaneReportEvent } from "./verifiedPaneReports";
import { createVerifiedPaneReports } from "./verifiedPaneReports";

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

/** A deck store holding exactly one workspace with the given pane ids. */
const deckWith = (...paneIds: string[]) =>
  ({
    getSnapshot: () => ({
      workspaces: [{ id: "ws-1", panes: paneIds.map((id) => ({ id })) }],
    }),
    subscribe: () => () => {},
  }) as unknown as DeckStore;

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
      Parameters<typeof createVerifiedPaneReports>[1]
    > = {},
  ) =>
    createVerifiedPaneReports(deck, {
      label: "test report",
      subscribe,
      apply,
      ...over,
    });

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
    handler!({ paneId: "pane-9", token: "tok", payload: {} });
    expect(apply).not.toHaveBeenCalled();
    expect(stubs.warn).toHaveBeenCalledWith(
      "web:bridge",
      expect.stringContaining("closed pane pane-9"),
    );
  });

  it("drops a report whose token does not match the spawn plan", async () => {
    start(deckWith("pane-1"));
    await settle();
    handler!({ paneId: "pane-1", token: "stale", payload: {} });
    expect(apply).not.toHaveBeenCalled();
    expect(stubs.warn).toHaveBeenCalledWith(
      "web:bridge",
      expect.stringContaining("wrong token"),
    );
    // No cached plan at all (dropped on restart) refuses too.
    stubs.peekPaneSpawnSpec.mockReturnValue(undefined);
    handler!({ paneId: "pane-1", token: "tok", payload: {} });
    expect(apply).not.toHaveBeenCalled();
  });

  it("requireLiveProcess drops reports from a dead process, allows a starting one", async () => {
    start(deckWith("pane-1"), { requireLiveProcess: true });
    await settle();
    stubs.paneSessionState.mockReturnValue({ kind: "exited", code: 1 });
    handler!({ paneId: "pane-1", token: "tok", payload: {} });
    expect(apply).not.toHaveBeenCalled();
    expect(stubs.warn).toHaveBeenCalledWith(
      "web:bridge",
      expect.stringContaining("no live process (exited)"),
    );
    // A hook can beat the spawn promise's resolution — starting counts.
    stubs.paneSessionState.mockReturnValue({ kind: "starting" });
    handler!({ paneId: "pane-1", token: "tok", payload: {} });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("without requireLiveProcess a dead process still reports (the usage lane)", async () => {
    start(deckWith("pane-1"));
    await settle();
    stubs.paneSessionState.mockReturnValue({ kind: "exited", code: 1 });
    handler!({ paneId: "pane-1", token: "tok", payload: {} });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on dispose, and immediately when disposed mid-subscribe", async () => {
    const lane = start(deckWith("pane-1"));
    await settle();
    lane.dispose();
    expect(unlisten).toHaveBeenCalledTimes(1);
    // A report arriving after dispose is dropped even if the transport has
    // not detached yet.
    handler!({ paneId: "pane-1", token: "tok", payload: {} });
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
