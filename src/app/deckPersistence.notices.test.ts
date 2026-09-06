import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** A v10 file whose one named team ran in two directories — the shape the
 * ladder dissolves and says so about. */
const SPREAD = JSON.stringify({
  version: 10,
  minVersion: 1,
  activeId: "ws-1",
  focusByWs: {},
  selectByWs: {},
  workspaces: [
    {
      id: "ws-1",
      name: "web",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        { id: "pane-1", agentType: "claude", cwd: "/wt/1", team: { name: "api", role: "lead" } },
        { id: "pane-2", agentType: "claude", cwd: "/wt/2", team: { name: "api", role: "impl-1" } },
      ],
    },
  ],
});

/** The same deck a build of this revision would write: nothing to say. */
const CURRENT = SPREAD.replace('"version":10,"minVersion":1', '"version":11,"minVersion":11');

describe("createDeckPersistence — migration notices", () => {
  let persistence: DeckPersistence | null = null;
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    ipc.loadDeckState.mockReset();
  });
  afterEach(() => {
    persistence?.dispose();
    persistence = null;
  });

  it("hands the ladder's notices over once, on the launch that migrated", async () => {
    ipc.loadDeckState.mockResolvedValue(SPREAD);
    const heard = vi.fn<(notices: readonly string[]) => void>();
    persistence = createDeckPersistence(createDeckStore(), heard);
    await settled();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0]).toHaveLength(1);
    expect(heard.mock.calls[0][0][0]).toContain("dissolved");
  });

  it("says nothing for a file that needed no migrating", async () => {
    ipc.loadDeckState.mockResolvedValue(CURRENT);
    const heard = vi.fn<(notices: readonly string[]) => void>();
    persistence = createDeckPersistence(createDeckStore(), heard);
    await settled();
    expect(heard).not.toHaveBeenCalled();
  });
});
