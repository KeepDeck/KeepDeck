// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUsage } from "@keepdeck/plugin-api";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { createDeckStore } from "./deckStore";
import { createDeckActions, type DeckActions } from "./deckActions";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ipc = vi.hoisted(() => ({
  watchSessionFile: vi.fn<
    (paneId: string, path: string, token: string, format: string) => Promise<void>
  >(() => Promise.resolve()),
  unwatchSessionFile: vi.fn(() => Promise.resolve()),
  findCodexRollout: vi.fn<(sessionId: string) => Promise<string | null>>(() =>
    Promise.resolve("/rollout.jsonl"),
  ),
  onSessionBound: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../ipc/usage", () => ({
  watchSessionFile: ipc.watchSessionFile,
  unwatchSessionFile: ipc.unwatchSessionFile,
  findCodexRollout: ipc.findCodexRollout,
}));
vi.mock("../ipc/sessions", () => ({ onSessionBound: ipc.onSessionBound }));
vi.mock("../ipc/log", () => ({
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// The spawn token is what a tail authenticates with. Suspend drops the spec,
// and the resume mints a NEW token — which is the whole point of these tests.
const specs = vi.hoisted(() => ({ token: "token-1" as string | null }));
vi.mock("./spawnSpecs", () => ({
  peekPaneSpawnSpec: () => (specs.token ? { token: specs.token } : undefined),
  // Present for the binding lane composed below; these tests build no fork
  // plan, so there is nothing for it to stamp.
  bindPaneSpawnSpecSession: () => {},
}));
import { createUsageTailsLane } from "./usageChannelTails";
import type { UsageLane } from "./usageChannelSource";
import { createUsageManager } from "./usageManager";
import { createPaneAttribution } from "./paneAttribution";
import {
  createSessionBinding,
  type SessionBinding,
} from "./sessionBinding";

const usageByAgent = new Map<string, AgentUsage>([
  [
    "codex",
    // Only `tail` is read here; the lane never normalizes in these tests.
    { tail: { format: "codex", watches: [] } } as unknown as AgentUsage,
  ],
]);

let deck: DeckActions;

function seed() {
  act(() => {
    deck.createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        {
          id: "pane-1",
          agentType: "codex",
          session: { id: "s-1", boundAt: "2026-07-25T09:00:00.000Z" },
        },
      ],
    });
  });
}

describe("usage tails — a suspended pane's watcher", () => {
  let lane: UsageLane;
  let bindings: SessionBinding;

  beforeEach(() => {
    ipc.watchSessionFile.mockClear();
    ipc.unwatchSessionFile.mockClear();
    ipc.findCodexRollout.mockClear();
    specs.token = "token-1";
    const store = createDeckStore();
    deck = createDeckActions(store);
    // The real rule and the real binding lane over it, as the runtime
    // composes them — the tails lane follows what the binding lane accepted.
    const attribution = createPaneAttribution({
      workspaces: () => store.getSnapshot().workspaces,
      secretOf: () => specs.token ?? undefined,
    });
    bindings = createSessionBinding(
      store,
      { retire: () => {}, beginSession: () => {} },
      attribution,
    );
    lane = createUsageTailsLane({
      deck: store,
      attribution,
      bindings,
      // These panes reach the tail through the FALLBACK — a recorded session
      // with no binding — and finding the store is now the dialect's answer
      // rather than a command of the host's. The fake is that search, over
      // the same mocked lookup this file already had.
      tailOf: () =>
        ({
          watches: [],
          follow: async ({ sessionId }: { sessionId: string | null }) => {
            const path = sessionId ? await ipc.findCodexRollout(sessionId) : null;
            return path ? { path } : null;
          },
        }) as never,
      // The tails lane only arms watchers; events reach the store via the
      // reports lane, so a fresh, unobserved instance satisfies the context.
      usage: createUsageManager(),
      declarations: {
        current: () => usageByAgent,
        subscribe: () => () => {},
      },
    });
  });

  afterEach(() => {
    lane.dispose();
  });

  const settle = async () => {
    for (let i = 0; i < 4; i++) await act(async () => {});
  };

  it("is released on suspend and re-armed on resume, with the NEW token", async () => {
    // Suspend drops the pane's spawn spec, so the resume mints a fresh token
    // (`spawnSpecs`: the cached one is gone). A watcher kept across that
    // rotation still echoes the OLD token, so every report it sends is
    // rejected as unauthenticated — the pane's usage goes silently dead for
    // the rest of its life, because the fallback lane never re-arms a pane it
    // still believes is tailed. Releasing it on suspend is what makes the
    // resume able to arm a live one.
    seed();
    await settle();
    expect(ipc.watchSessionFile).toHaveBeenCalledTimes(1);
    expect(ipc.watchSessionFile.mock.calls[0][2]).toBe("token-1");

    act(() => deck.suspendPane("ws-1", "pane-1"));
    await settle();
    expect(ipc.unwatchSessionFile).toHaveBeenCalledWith("pane-1");

    // The resume: a new process, a new token.
    specs.token = "token-2";
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    act(() => deck.clearPaneIdle("ws-1", "pane-1"));
    await settle();

    expect(ipc.watchSessionFile).toHaveBeenCalledTimes(2);
    expect(ipc.watchSessionFile.mock.calls[1][2]).toBe("token-2");
  });

  it("keeps tailing a pane that is merely rising", async () => {
    // A pane on its way up still owns its process-to-be; only a pane that is
    // really stopped has a dead file behind it.
    seed();
    await settle();
    ipc.unwatchSessionFile.mockClear();

    act(() => deck.suspendPane("ws-1", "pane-1"));
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    // It was released by the suspend and not re-armed while still idle —
    // arming needs a live spawn token, which a rising pane does not yet have.
    expect(ipc.watchSessionFile).toHaveBeenCalledTimes(1);
  });

  it("still releases a tail when the pane leaves the deck", async () => {
    // The pre-existing sweep must keep working: this is the only thing that
    // frees a native watcher for a pane that is closed outright.
    seed();
    await settle();

    act(() => deck.closeAgent("ws-1", "pane-1"));
    await settle();

    expect(ipc.unwatchSessionFile).toHaveBeenCalledWith("pane-1");
  });
});
