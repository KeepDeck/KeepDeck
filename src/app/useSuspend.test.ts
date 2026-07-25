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

import {
  suspendRefusalText,
  useSuspend,
  type SuspendApi,
  type SuspendOutcome,
} from "./useSuspend";

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

    let first!: Promise<SuspendOutcome>;
    act(() => {
      first = suspend.suspend("ws-1", "pane-1");
    });
    await act(async () => suspend.suspend("ws-1", "pane-1"));
    act(() => release());
    await act(async () => first);

    expect(pty.closePane).toHaveBeenCalledTimes(1);
  });

  it("names the reason it refuses, so every surface can say the same thing", async () => {
    // A bare `false` forced each caller to guess, and one guessed wrong: it
    // told a remote pane's user their running agent had no session to stop.
    seed({ provisioning: { repo: "/repo", workspace: "ws", index: 1 } });
    expect(await act(async () => suspend.suspend("ws-1", "pane-1"))).toBe(
      "provisioning",
    );
    expect(pty.closePane).not.toHaveBeenCalled();
    expect(pane().idle).toBeUndefined();

    expect(await act(async () => suspend.suspend("ws-1", "nope"))).toBe("gone");
    expect(await act(async () => suspend.suspend("nope", "pane-1"))).toBe("gone");
    expect(pty.closePane).not.toHaveBeenCalled();
  });

  it("refuses a pane that is ALREADY idle, whatever put it there", async () => {
    // Without this the second gesture would re-run the whole teardown on a
    // pane with no process — and, for a suspended one, restamp its card.
    seed({ idle: { reason: "suspended", at: "2026-07-25T08:00:00.000Z" } });
    expect(await act(async () => suspend.suspend("ws-1", "pane-1"))).toBe("idle");
    expect(pty.closePane).not.toHaveBeenCalled();
    expect(plans.dropPaneSpawnSpec).not.toHaveBeenCalled();
    expect(pane().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T08:00:00.000Z",
    });
  });

  it("reports the in-flight refusal apart from every other one", async () => {
    seed();
    let release!: () => void;
    pty.closePane.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    let first!: Promise<SuspendOutcome>;
    act(() => {
      first = suspend.suspend("ws-1", "pane-1");
    });
    // Distinct from "idle": the pane is not stopped yet, someone is stopping it.
    expect(await act(async () => suspend.suspend("ws-1", "pane-1"))).toBe(
      "in-flight",
    );
    act(() => release());
    expect(await act(async () => first)).toBe("suspended");
  });

  it("refuses a REMOTE pane BY NAME — its session lives on the server", async () => {
    seed({ remoteEndpoint: "ws://vps:4500" });

    // The reason, not just the refusal: this is the one the union was
    // introduced for, and the one a guessing caller got wrong.
    expect(await act(async () => suspend.suspend("ws-1", "pane-1"))).toBe(
      "remote",
    );
    expect(pty.closePane).not.toHaveBeenCalled();
    expect(pane().idle).toBeUndefined();
  });

  it("leaves the pane resumable: stamped, bound, and stopped", async () => {
    // Resuming itself belongs to the revive sweep (see useRevive.test.ts) —
    // what suspend owes it is a pane that still has everything the wake will
    // need, and a stamp the wake can put back if it fails.
    seed();
    await act(async () => suspend.suspend("ws-1", "pane-1"));

    expect(pane().idle).toEqual({
      reason: "suspended",
      at: expect.any(String),
    });
    expect(pane().session).toEqual({
      id: "s-1",
      boundAt: "2026-07-25T09:00:00.000Z",
    });
    expect(pane().cwd).toBe("/worktree");
  });

  it("survives its workspace closing mid-reap, and releases the pane afterwards", async () => {
    seed();
    pty.closePane.mockImplementationOnce(async () => {
      act(() => deck.closeWorkspace("ws-1"));
    });

    // Resolves rather than throwing on the vanished pane…
    expect(await act(async () => suspend.suspend("ws-1", "pane-1"))).toBe(
      "suspended",
    );
    expect(deck.workspaces).toHaveLength(0);

    // …and the in-flight guard is released, so the id is usable again — a
    // leaked entry would make that pane unsuspendable for the whole session.
    seed();
    pty.closePane.mockClear();
    expect(await act(async () => suspend.suspend("ws-1", "pane-1"))).toBe(
      "suspended",
    );
    expect(pty.closePane).toHaveBeenCalledWith("pane-1");
  });
});

describe("suspendRefusalText", () => {
  it("gives every refusal its own sentence", () => {
    // One wording, shared by the hotkey, the command and the close dialog —
    // the whole reason the outcome is a reason and not a boolean.
    expect(suspendRefusalText("idle", "Agent 1")).toContain("already stopped");
    expect(suspendRefusalText("provisioning", "Agent 1")).toContain("worktree");
    expect(suspendRefusalText("in-flight", "Agent 1")).toContain(
      "already being suspended",
    );
    expect(suspendRefusalText("gone", "Agent 1")).toContain("no longer open");
  });

  it("tells a remote pane's user the truth about where its session lives", () => {
    // The sentence this type exists for: the earlier boolean made one surface
    // claim a running remote agent had no session to stop.
    const text = suspendRefusalText("remote", "Agent 1");
    expect(text).toContain("remote server");
    expect(text).not.toContain("no session");
  });

  it("names the pane in every sentence", () => {
    for (const outcome of ["idle", "provisioning", "remote", "in-flight", "gone"] as const) {
      expect(suspendRefusalText(outcome, "Reviewer")).toContain("Reviewer");
    }
  });
});
