// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReportEvent } from "../ipc/usage";
import { getUsageSnapshot, resetUsageManager } from "./usageManager";
import { useUsageChannel } from "./useUsageChannel";
import type { Deck } from "./useDeck";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ipc = vi.hoisted(() => ({
  onUsageReport: vi.fn(),
  onSessionBound: vi.fn(),
  watchRollout: vi.fn(),
  unwatchRollout: vi.fn(),
  peekPaneSpawnSpec: vi.fn(),
}));
vi.mock("../ipc/usage", () => ({
  onUsageReport: ipc.onUsageReport,
  watchRollout: ipc.watchRollout,
  unwatchRollout: ipc.unwatchRollout,
}));
vi.mock("../ipc/sessions", () => ({ onSessionBound: ipc.onSessionBound }));
vi.mock("./spawnSpecs", () => ({ peekPaneSpawnSpec: ipc.peekPaneSpawnSpec }));

/** The channel only reads `deck.workspaces` — a shaped literal is enough. */
const deckWith = (panes: { id: string; agentType?: string }[]): Deck =>
  ({
    workspaces: [
      {
        id: "ws-1",
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes,
      },
    ],
  }) as unknown as Deck;

function Probe({ deck }: { deck: Deck }) {
  useUsageChannel(deck);
  return null;
}

const CLAUDE_REPORT = {
  agent: "claude",
  statusline: {
    rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_738_425_600 } },
  },
};

interface Bound {
  paneId: string;
  token: string;
  transcriptPath?: string;
}

describe("useUsageChannel", () => {
  let root: Root;
  let emit: (report: UsageReportEvent) => void;
  let emitBound: (bound: Bound) => void;

  const mount = async (deck: Deck) => {
    act(() => root.render(createElement(Probe, { deck })));
    await act(async () => {});
  };

  beforeEach(async () => {
    resetUsageManager();
    ipc.onUsageReport.mockReset().mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
    ipc.onSessionBound.mockReset().mockImplementation((handler) => {
      emitBound = handler;
      return Promise.resolve(() => {});
    });
    ipc.watchRollout.mockReset().mockResolvedValue(undefined);
    ipc.unwatchRollout.mockReset().mockResolvedValue(undefined);
    ipc.peekPaneSpawnSpec
      .mockReset()
      .mockImplementation((paneId: string) =>
        paneId === "pane-1" ? { token: "tok-1" } : undefined,
      );
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    await mount(deckWith([{ id: "pane-1" }]));
  });

  afterEach(() => {
    act(() => root.unmount());
    resetUsageManager();
  });

  it("applies a report that echoes the pane's spawn token", async () => {
    await act(async () => {
      emit({ paneId: "pane-1", token: "tok-1", payload: CLAUDE_REPORT });
    });
    expect(getUsageSnapshot().accounts.get("claude")).toMatchObject({
      kind: "reported",
      sourcePaneId: "pane-1",
    });
  });

  it("rejects wrong tokens and unknown panes", async () => {
    await act(async () => {
      emit({ paneId: "pane-1", token: "forged", payload: CLAUDE_REPORT });
      emit({ paneId: "pane-ghost", token: "tok-1", payload: CLAUDE_REPORT });
    });
    expect(getUsageSnapshot().accounts.size).toBe(0);
  });

  it("prunes pane usage when a pane leaves the deck, keeping the account", async () => {
    await act(async () => {
      emit({ paneId: "pane-1", token: "tok-1", payload: CLAUDE_REPORT });
    });
    expect(getUsageSnapshot().panes.has("pane-1")).toBe(true);

    await mount(deckWith([]));
    expect(getUsageSnapshot().panes.has("pane-1")).toBe(false);
    expect(getUsageSnapshot().accounts.get("claude")).toBeDefined();
  });

  it("arms the rollout tail for a codex binding carrying a transcript", async () => {
    await mount(deckWith([{ id: "pane-1", agentType: "codex" }]));
    await act(async () => {
      emitBound({
        paneId: "pane-1",
        token: "tok-1",
        transcriptPath: "/x/rollout.jsonl",
      });
    });
    expect(ipc.watchRollout).toHaveBeenCalledWith(
      "pane-1",
      "/x/rollout.jsonl",
      "tok-1",
    );
  });

  it("never arms tails for non-codex panes, forged tokens or bare bindings", async () => {
    // Default pane-1 is claude (no agentType) — transcript or not, no tail.
    await act(async () => {
      emitBound({ paneId: "pane-1", token: "tok-1", transcriptPath: "/x/r.jsonl" });
    });
    await mount(deckWith([{ id: "pane-1", agentType: "codex" }]));
    await act(async () => {
      emitBound({ paneId: "pane-1", token: "forged", transcriptPath: "/x/r.jsonl" });
      emitBound({ paneId: "pane-1", token: "tok-1" });
    });
    expect(ipc.watchRollout).not.toHaveBeenCalled();
  });

  it("unwatches the tail when its pane leaves the deck", async () => {
    await mount(deckWith([{ id: "pane-1", agentType: "codex" }]));
    await act(async () => {
      emitBound({
        paneId: "pane-1",
        token: "tok-1",
        transcriptPath: "/x/rollout.jsonl",
      });
    });
    await mount(deckWith([]));
    expect(ipc.unwatchRollout).toHaveBeenCalledWith("pane-1");
  });
});
