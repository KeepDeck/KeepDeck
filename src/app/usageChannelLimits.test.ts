// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountUsage, AgentUsage } from "@keepdeck/plugin-api";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { createDeckActions } from "./deckActions";
import { createDeckStore } from "./deckStore";
import { createPaneAttribution } from "./paneAttribution";
import { createUsageManager } from "./usageManager";
import { createUsageSightings } from "./usageSightings";

vi.mock("../ipc/log", () => ({
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
import { log } from "../ipc/log";
import { createUsageLimitsLane, LIMITS_POLL_MS } from "./usageChannelLimits";

const ACCOUNT: AccountUsage = { kind: "reported", windows: [], reportedAt: 1, sourcePaneId: "pane-1" };

describe("the limits lane's word on an answer that does not normalize", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(log.info).mockClear();
  });

  /** A deck with one live pane of `agent`, whose limits read answers and
   * normalizes as `normalizes` says at the moment of each read. */
  function lane(normalizes: { now: boolean }) {
    const store = createDeckStore();
    createDeckActions(store).createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [{ id: "pane-1", agentType: "kimi" }],
    });
    const declaration: AgentUsage = {
      normalize: () => null,
      limits: {
        read: () => Promise.resolve({ body: "{}", sourceAt: 1 }),
        normalize: () => (normalizes.now ? ACCOUNT : null),
      },
    };
    return createUsageLimitsLane({
      deck: store,
      attribution: createPaneAttribution({
        workspaces: () => store.getSnapshot().workspaces,
        reports: () => true,
        swapSources: () => [],
      }),
      bindings: { subscribe: () => () => {} },
      declarations: { current: () => new Map([["kimi", declaration]]), subscribe: () => () => {} },
      usage: createUsageManager(),
      sightings: createUsageSightings(),
      tailOf: () => undefined,
      companionOf: () => undefined,
    });
  }

  const said = () => vi.mocked(log.info).mock.calls.map(([, message]) => message);

  it("says it once when the answer stops normalizing, and once when it starts again", async () => {
    const normalizes = { now: false };
    const limits = lane(normalizes);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(LIMITS_POLL_MS);
      expect(said()).toEqual([expect.stringContaining("kimi limits poll: response did not normalize")]);

      normalizes.now = true;
      await vi.advanceTimersByTimeAsync(LIMITS_POLL_MS);
      await vi.advanceTimersByTimeAsync(LIMITS_POLL_MS);
      expect(said()).toEqual([
        expect.stringContaining("did not normalize"),
        expect.stringContaining("kimi limits poll: the response normalizes again"),
      ]);
    } finally {
      limits.dispose();
    }
  });

  it("says nothing of an answer that always normalizes", async () => {
    const limits = lane({ now: true });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(LIMITS_POLL_MS * 2);
      expect(said()).toEqual([]);
    } finally {
      limits.dispose();
    }
  });
});
