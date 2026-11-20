import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckLoad } from "../domain/lifecycle";
import { createDeckStore } from "./deckStore";
import { createDeckPersistence, type DeckPersistence } from "./deckPersistence";

const ipc = vi.hoisted(() => ({
  loadDeckState: vi.fn<() => Promise<string | null>>(),
  saveDeckState: vi.fn<(json: string) => Promise<void>>(() => Promise.resolve()),
  quarantineDeckState: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("../ipc/state", () => ipc);
vi.mock("./settingsManager", () => ({
  initSettings: () => Promise.resolve(),
  getSettings: () => ({ parkAgentsOnLaunch: false }),
}));

const STORED = JSON.stringify({
  version: 11,
  minVersion: 11,
  activeId: "ws-1",
  focusByWs: {},
  selectByWs: {},
  workspaces: [{ id: "ws-1", name: "web", cwd: "/repo", worktreeBaseDir: null, panes: [{ id: "pane-1", agentType: "claude" }] }],
});
const NEWER = JSON.stringify({ version: 9_999, minVersion: 9_999, workspaces: [] });

/** The deck's handshake facts are read off what it loaded, and how. */
describe("the deck's boot snapshot and saved revisions", () => {
  let persistence: DeckPersistence | null = null;
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    ipc.loadDeckState.mockReset();
    ipc.saveDeckState.mockReset();
    ipc.saveDeckState.mockResolvedValue(undefined);
    ipc.quarantineDeckState.mockReset();
    ipc.quarantineDeckState.mockResolvedValue(undefined);
  });
  afterEach(() => {
    persistence?.dispose();
    persistence = null;
    vi.useRealTimers();
  });

  async function loadedAs(file: () => Promise<string | null>): Promise<DeckLoad | null> {
    ipc.loadDeckState.mockImplementation(file);
    persistence = createDeckPersistence(createDeckStore());
    expect(persistence.getSnapshot().load).toBeNull();
    await settled();
    await settled();
    return persistence.getSnapshot().load;
  }

  it("says how the deck loaded, in each of the five ways", async () => {
    expect(await loadedAs(() => Promise.resolve(STORED))).toBe("loaded");
    persistence?.dispose();
    expect(await loadedAs(() => Promise.resolve(null))).toBe("loaded");
    persistence?.dispose();
    expect(await loadedAs(() => Promise.resolve("not json"))).toBe("quarantined");
    persistence?.dispose();
    ipc.quarantineDeckState.mockRejectedValue(new Error("read-only"));
    expect(await loadedAs(() => Promise.resolve("not json"))).toBe("quarantineFailed");
    persistence?.dispose();
    expect(await loadedAs(() => Promise.resolve(NEWER))).toBe("newer");
    persistence?.dispose();
    expect(await loadedAs(() => Promise.reject(new Error("EACCES")))).toBe("readFailed");
  });

  it("names the revision of every snapshot it got on disk, and none it did not", async () => {
    vi.useFakeTimers();
    ipc.loadDeckState.mockResolvedValue(STORED);
    const store = createDeckStore();
    const saved = vi.fn<(revision: number) => void>();
    persistence = createDeckPersistence(store, () => {}, saved);
    await vi.runAllTimersAsync();
    expect(saved).toHaveBeenLastCalledWith(store.revision());

    ipc.saveDeckState.mockRejectedValueOnce(new Error("disk full"));
    store.dispatch({ type: "renamePane", wsId: "ws-1", paneId: "pane-1", name: "api" });
    const changed = store.revision();
    saved.mockClear();
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(saved).toHaveBeenCalledWith(changed);
  });

  it("writes nothing while this copy only shows, and saves what changed once it holds the folder", async () => {
    vi.useFakeTimers();
    ipc.loadDeckState.mockResolvedValue(STORED);
    const store = createDeckStore();
    persistence = createDeckPersistence(store);
    await vi.runAllTimersAsync();
    ipc.saveDeckState.mockClear();

    persistence.mayWrite(false);
    store.dispatch({ type: "renamePane", wsId: "ws-1", paneId: "pane-1", name: "api" });
    await vi.runAllTimersAsync();
    expect(ipc.saveDeckState).not.toHaveBeenCalled();

    persistence.mayWrite(true);
    await vi.runAllTimersAsync();
    expect(ipc.saveDeckState).toHaveBeenCalledTimes(1);
    expect(ipc.saveDeckState.mock.calls[0][0]).toContain('"api"');
  });
});
