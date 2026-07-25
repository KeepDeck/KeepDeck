// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Pane } from "../domain/deck";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const plans = vi.hoisted(() => ({ dropPaneSpawnSpec: vi.fn() }));
vi.mock("./spawnSpecs", () => plans);

const pty = vi.hoisted(() => ({
  closePane: vi.fn<(paneId: string) => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("./ptyManager", () => pty);

const usage = vi.hoisted(() => ({ clearPaneUsage: vi.fn() }));
vi.mock("./usageManager", () => usage);

vi.mock("../ipc/log", () => ({
  log: { info: vi.fn(), warn: vi.fn() },
  describeError: (error: unknown) => String(error),
}));

import { useSuspend, type SuspendApi } from "./useSuspend";

let deck: Deck;
let suspend: SuspendApi;

function Probe() {
  deck = useDeck();
  suspend = useSuspend(deck);
  return null;
}

function seed(pane: Partial<Pane> = {}) {
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
          cwd: "/worktree",
          branch: "feature/x",
          session: { id: "s-1", boundAt: "2026-07-25T09:00:00.000Z" },
          ...pane,
        },
      ],
    });
  });
}

const pane = () => deck.workspaces[0].panes[0];

describe("useSuspend", () => {
  let root: Root;

  beforeEach(() => {
    plans.dropPaneSpawnSpec.mockClear();
    pty.closePane.mockReset().mockResolvedValue(undefined);
    usage.clearPaneUsage.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("stops the process but keeps the pane, its worktree and its resume key", async () => {
    seed();

    await act(async () => suspend.suspend("ws-1", "pane-1"));

    expect(pty.closePane).toHaveBeenCalledWith("pane-1");
    expect(pane()).toEqual({
      id: "pane-1",
      agentType: "codex",
      cwd: "/worktree",
      branch: "feature/x",
      session: { id: "s-1", boundAt: "2026-07-25T09:00:00.000Z" },
      idle: { reason: "suspended", at: expect.any(String) },
    });
  });

  it("marks the pane idle BEFORE reaping, so no sweep can respawn it mid-flight", async () => {
    seed();
    // A teardown that never finishes: the pane must ALREADY be out of the
    // spawn sweep's reach while the process is still being reaped. Reaping
    // first would leave a live, plan-less pane across that await — long enough
    // for the sweep to hand it a fresh plan and a NEW process, which this
    // suspend would then orphan (unmounting a view never kills a session).
    pty.closePane.mockImplementation(() => new Promise<void>(() => {}));

    await act(async () => {
      void suspend.suspend("ws-1", "pane-1");
    });

    expect(pty.closePane).toHaveBeenCalledWith("pane-1");
    expect(pane().idle).toEqual({
      reason: "suspended",
      at: expect.any(String),
    });
  });

  it("revokes the bridge token and drops the pane's usage", async () => {
    seed();

    await act(async () => suspend.suspend("ws-1", "pane-1"));

    expect(plans.dropPaneSpawnSpec).toHaveBeenCalledWith("pane-1");
    expect(usage.clearPaneUsage).toHaveBeenCalledWith("pane-1");
  });

  it("ignores a second gesture while the first is still reaping", async () => {
    seed();
    let release!: () => void;
    pty.closePane.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    let first!: Promise<void>;
    act(() => {
      first = suspend.suspend("ws-1", "pane-1");
    });
    await act(async () => suspend.suspend("ws-1", "pane-1"));
    act(() => release());
    await act(async () => first);

    expect(pty.closePane).toHaveBeenCalledTimes(1);
  });

  it("refuses a pane that is provisioning, already idle, remote, or unknown", async () => {
    seed({ provisioning: { repo: "/repo", workspace: "ws", index: 1 } });
    await act(async () => suspend.suspend("ws-1", "pane-1"));
    expect(pty.closePane).not.toHaveBeenCalled();
    expect(pane().idle).toBeUndefined();

    await act(async () => suspend.suspend("ws-1", "nope"));
    await act(async () => suspend.suspend("nope", "pane-1"));
    expect(pty.closePane).not.toHaveBeenCalled();
  });

  it("refuses a REMOTE pane — it has no local session to resume", async () => {
    seed({ remoteEndpoint: "ws://vps:4500" });

    await act(async () => suspend.suspend("ws-1", "pane-1"));

    expect(pty.closePane).not.toHaveBeenCalled();
    expect(pane().idle).toBeUndefined();
  });

  it("resume hands the pane back to the revive sweep as a restored one", async () => {
    seed();
    await act(async () => suspend.suspend("ws-1", "pane-1"));

    act(() => suspend.resume("ws-1", "pane-1"));

    // NOT live yet: the sweep still has to probe the directory and build the
    // resume plan — resuming reuses that path rather than duplicating it. The
    // reason records that a HUMAN asked, which is what keeps a rejected
    // session id from silently becoming a new conversation.
    expect(pane().idle).toEqual({ reason: "resuming" });
    expect(pane().session).toEqual({
      id: "s-1",
      boundAt: "2026-07-25T09:00:00.000Z",
    });
  });

  it("suspending a pane whose workspace vanished mid-reap changes nothing", async () => {
    seed();
    pty.closePane.mockImplementation(async () => {
      act(() => deck.closeWorkspace("ws-1"));
    });

    await act(async () => suspend.suspend("ws-1", "pane-1"));

    expect(deck.workspaces).toHaveLength(0);
  });
});
