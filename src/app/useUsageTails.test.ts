// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUsage } from "@keepdeck/plugin-api";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { createDeckStore } from "./deckStore";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ipc = vi.hoisted(() => ({
  watchSessionFile: vi.fn<
    (paneId: string, path: string, token: string, format: string) => Promise<void>
  >(() => Promise.resolve()),
  unwatchSessionFile: vi.fn(() => Promise.resolve()),
  findCodexRollout: vi.fn(() => Promise.resolve("/rollout.jsonl")),
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
}));
vi.mock("./useSessionBinding", () => ({ postbackAccepted: () => true }));

import { useUsageTails } from "./useUsageTails";

const usageByAgent = new Map<string, AgentUsage>([
  ["codex", { tail: "codex" } as AgentUsage],
]);

let deck: Deck;

function Probe() {
  // Fresh per mount (a bare call would rebuild it on every render).
  const [store] = useState(createDeckStore);
  deck = useDeck(store);
  useUsageTails(deck, usageByAgent);
  return null;
}

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

describe("useUsageTails — a suspended pane's watcher", () => {
  let root: Root;

  beforeEach(() => {
    ipc.watchSessionFile.mockClear();
    ipc.unwatchSessionFile.mockClear();
    ipc.findCodexRollout.mockClear();
    specs.token = "token-1";
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
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
