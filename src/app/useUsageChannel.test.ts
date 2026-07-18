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
  peekPaneSpawnSpec: vi.fn(),
}));
vi.mock("../ipc/usage", () => ({ onUsageReport: ipc.onUsageReport }));
vi.mock("./spawnSpecs", () => ({ peekPaneSpawnSpec: ipc.peekPaneSpawnSpec }));

/** The channel only reads `deck.workspaces` — a shaped literal is enough. */
const deckWith = (paneIds: string[]): Deck =>
  ({
    workspaces: [
      {
        id: "ws-1",
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: paneIds.map((id) => ({ id })),
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

describe("useUsageChannel", () => {
  let root: Root;
  let emit: (report: UsageReportEvent) => void;

  beforeEach(async () => {
    resetUsageManager();
    ipc.onUsageReport.mockReset().mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
    ipc.peekPaneSpawnSpec
      .mockReset()
      .mockImplementation((paneId: string) =>
        paneId === "pane-1" ? { token: "tok-1" } : undefined,
      );
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe, { deck: deckWith(["pane-1"]) })));
    await act(async () => {});
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

    act(() => root.render(createElement(Probe, { deck: deckWith([]) })));
    await act(async () => {});
    expect(getUsageSnapshot().panes.has("pane-1")).toBe(false);
    expect(getUsageSnapshot().accounts.get("claude")).toBeDefined();
  });
});
