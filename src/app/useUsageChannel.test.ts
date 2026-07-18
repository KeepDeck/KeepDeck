// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUsage, NormalizedUsage } from "@keepdeck/plugin-api";
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
  watchSessionFile: vi.fn(),
  unwatchSessionFile: vi.fn(),
  fetchKimiUsages: vi.fn(),
  findCodexRollout: vi.fn(),
  peekPaneSpawnSpec: vi.fn(),
  // The agents contribution list the channel reads its declarations from.
  contributions: [] as { pluginId: string; entry: { id: string; usage?: AgentUsage } }[],
}));
vi.mock("../ipc/usage", () => ({
  onUsageReport: ipc.onUsageReport,
  watchSessionFile: ipc.watchSessionFile,
  unwatchSessionFile: ipc.unwatchSessionFile,
  fetchKimiUsages: ipc.fetchKimiUsages,
  findCodexRollout: ipc.findCodexRollout,
}));
vi.mock("../ipc/sessions", () => ({ onSessionBound: ipc.onSessionBound }));
vi.mock("./spawnSpecs", () => ({ peekPaneSpawnSpec: ipc.peekPaneSpawnSpec }));
vi.mock("./runtimeContext", () => ({
  useAppRuntime: () => ({ plugins: { pluginRegistries: { agents: {} } } }),
}));
vi.mock("../plugins/react", () => ({
  useContributions: () => ipc.contributions,
}));

/** A fake normalizer echoing fixed windows — the mechanics under test are
 * registration, arming and polling, not payload parsing. */
const reported = (at: number): NormalizedUsage => ({
  account: { kind: "reported", windows: [], reportedAt: at, sourcePaneId: "" },
  pane: { agent: "any", reportedAt: at },
});

/** The channel only reads `deck.workspaces` — a shaped literal is enough. */
const deckWith = (
  panes: {
    id: string;
    agentType?: string;
    dormant?: boolean;
    session?: { id: string };
  }[],
): Deck =>
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

  beforeEach(() => {
    resetUsageManager();
    ipc.contributions = [
      {
        pluginId: "keepdeck.claude",
        entry: { id: "claude", usage: { normalize: (_p, at) => reported(at) } },
      },
      {
        pluginId: "keepdeck.codex",
        entry: {
          id: "codex",
          usage: { normalize: (_p, at) => reported(at), tail: "codex" },
        },
      },
    ];
    ipc.onUsageReport.mockReset().mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
    ipc.onSessionBound.mockReset().mockImplementation((handler) => {
      emitBound = handler;
      return Promise.resolve(() => {});
    });
    ipc.watchSessionFile.mockReset().mockResolvedValue(undefined);
    ipc.unwatchSessionFile.mockReset().mockResolvedValue(undefined);
    ipc.fetchKimiUsages.mockReset().mockResolvedValue("{}");
    ipc.findCodexRollout.mockReset().mockResolvedValue(null);
    ipc.peekPaneSpawnSpec
      .mockReset()
      .mockImplementation((paneId: string) =>
        paneId === "pane-1" ? { token: "tok-1" } : undefined,
      );
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
    resetUsageManager();
  });

  it("registers plugin normalizers and applies token-verified reports", async () => {
    await mount(deckWith([{ id: "pane-1" }]));
    await act(async () => {
      emit({ paneId: "pane-1", token: "tok-1", payload: { agent: "claude" } });
    });
    expect(getUsageSnapshot().accounts.get("claude")).toMatchObject({
      kind: "reported",
      sourcePaneId: "pane-1",
    });
  });

  it("rejects wrong tokens and unknown panes", async () => {
    await mount(deckWith([{ id: "pane-1" }]));
    await act(async () => {
      emit({ paneId: "pane-1", token: "forged", payload: { agent: "claude" } });
      emit({ paneId: "pane-ghost", token: "tok-1", payload: { agent: "claude" } });
    });
    expect(getUsageSnapshot().accounts.size).toBe(0);
  });

  it("prunes pane usage when a pane leaves the deck, keeping the account", async () => {
    await mount(deckWith([{ id: "pane-1" }]));
    await act(async () => {
      emit({ paneId: "pane-1", token: "tok-1", payload: { agent: "claude" } });
    });
    expect(getUsageSnapshot().panes.has("pane-1")).toBe(true);

    await mount(deckWith([]));
    expect(getUsageSnapshot().panes.has("pane-1")).toBe(false);
    expect(getUsageSnapshot().accounts.get("claude")).toBeDefined();
  });

  it("arms the declared tail for a binding carrying a transcript", async () => {
    await mount(deckWith([{ id: "pane-1", agentType: "codex" }]));
    await act(async () => {
      emitBound({
        paneId: "pane-1",
        token: "tok-1",
        transcriptPath: "/x/rollout.jsonl",
      });
    });
    expect(ipc.watchSessionFile).toHaveBeenCalledWith(
      "pane-1",
      "/x/rollout.jsonl",
      "tok-1",
      "codex",
    );
  });

  it("never arms tails for undeclared agents, forged tokens or bare bindings", async () => {
    // claude declares no tail — transcript or not, nothing arms.
    await mount(deckWith([{ id: "pane-1" }]));
    await act(async () => {
      emitBound({ paneId: "pane-1", token: "tok-1", transcriptPath: "/x/r.jsonl" });
    });
    await mount(deckWith([{ id: "pane-1", agentType: "codex" }]));
    await act(async () => {
      emitBound({ paneId: "pane-1", token: "forged", transcriptPath: "/x/r.jsonl" });
      emitBound({ paneId: "pane-1", token: "tok-1" });
    });
    expect(ipc.watchSessionFile).not.toHaveBeenCalled();
  });

  it("arms a recorded codex session without a binding — the TUI-resume fallback", async () => {
    ipc.findCodexRollout.mockResolvedValue("/x/sessions/rollout-019f.jsonl");
    await mount(
      deckWith([
        { id: "pane-1", agentType: "codex", session: { id: "019f-recorded" } },
      ]),
    );
    await act(async () => {});
    expect(ipc.findCodexRollout).toHaveBeenCalledWith("019f-recorded");
    expect(ipc.watchSessionFile).toHaveBeenCalledWith(
      "pane-1",
      "/x/sessions/rollout-019f.jsonl",
      "tok-1",
      "codex",
    );
  });

  it("retries the fallback later when the rollout is not found yet", async () => {
    ipc.findCodexRollout.mockResolvedValue(null);
    await mount(
      deckWith([
        { id: "pane-1", agentType: "codex", session: { id: "019f-recorded" } },
      ]),
    );
    await act(async () => {});
    expect(ipc.watchSessionFile).not.toHaveBeenCalled();
    // A later sweep may succeed — the pane must not be marked tailed.
    ipc.findCodexRollout.mockResolvedValue("/x/rollout.jsonl");
    await mount(
      deckWith([
        { id: "pane-1", agentType: "codex", session: { id: "019f-recorded" } },
        { id: "pane-x" },
      ]),
    );
    await act(async () => {});
    expect(ipc.watchSessionFile).toHaveBeenCalledWith(
      "pane-1",
      "/x/rollout.jsonl",
      "tok-1",
      "codex",
    );
  });

  it("undoes an arm that lands after its pane already closed", async () => {
    // The native watch resolves only when we let it — the pane closes while
    // the arm is in flight.
    let finishWatch!: () => void;
    ipc.watchSessionFile.mockImplementation(
      () => new Promise<void>((resolve) => (finishWatch = resolve)),
    );
    ipc.findCodexRollout.mockResolvedValue("/x/rollout.jsonl");
    await mount(
      deckWith([
        { id: "pane-1", agentType: "codex", session: { id: "019f-recorded" } },
      ]),
    );
    await act(async () => {});
    expect(ipc.watchSessionFile).toHaveBeenCalled();

    // Pane closes; the sweep unwatches what it knows — the watch is still
    // in flight, so its late landing must be undone on settle.
    await mount(deckWith([]));
    ipc.unwatchSessionFile.mockClear();
    await act(async () => {
      finishWatch();
    });
    expect(ipc.unwatchSessionFile).toHaveBeenCalledWith("pane-1");
  });

  it("skips arming when the pane closed during the rollout lookup", async () => {
    let finishFind!: (path: string) => void;
    ipc.findCodexRollout.mockImplementation(
      () => new Promise<string>((resolve) => (finishFind = resolve)),
    );
    await mount(
      deckWith([
        { id: "pane-1", agentType: "codex", session: { id: "019f-recorded" } },
      ]),
    );
    await act(async () => {});
    await mount(deckWith([]));
    await act(async () => {
      finishFind("/x/rollout.jsonl");
    });
    expect(ipc.watchSessionFile).not.toHaveBeenCalled();
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
    expect(ipc.unwatchSessionFile).toHaveBeenCalledWith("pane-1");
  });

  it("polls a declared limits source only while its agent has a live pane", async () => {
    ipc.contributions = [
      ...ipc.contributions,
      {
        pluginId: "keepdeck.kimi",
        entry: {
          id: "kimi",
          usage: {
            normalize: (_p, at) => reported(at),
            tail: "kimi-wire",
            limits: {
              poll: "kimi-usages",
              normalize: (_body, at) => ({
                kind: "reported",
                windows: [],
                reportedAt: at,
                sourcePaneId: "",
              }),
            },
          },
        },
      },
    ];
    // No kimi pane (dormant doesn't count) → no fetch.
    await mount(deckWith([{ id: "pane-1" }, { id: "pane-2", agentType: "kimi", dormant: true }]));
    expect(ipc.fetchKimiUsages).not.toHaveBeenCalled();

    // A live kimi pane → an immediate fetch lands in the store.
    await mount(deckWith([{ id: "pane-2", agentType: "kimi" }]));
    await act(async () => {});
    expect(ipc.fetchKimiUsages).toHaveBeenCalledTimes(1);
    expect(getUsageSnapshot().accounts.get("kimi")).toMatchObject({
      kind: "reported",
    });
  });
});
