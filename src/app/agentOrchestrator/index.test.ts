// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Probe,
  agentRun,
  buildResumeSpec,
  catalog,
  createWorkspaceInstance,
  deck,
  emptyJournal,
  gate,
  ipc,
  peekPaneSpawnSpec,
  pty,
  resetPaneSpawnSpecs,
  restored,
  settle,
  skillsAsked,
} from "./testSupport";
import type { DeckState } from "./testSupport";

describe("agent orchestrator —session policy", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    skillsAsked.mockClear();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    catalog.moveSuspendedToTray = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const pane = () => deck.workspaces[0].panes[0];

  it("publishes the resumed pane's plan, not just the process", async () => {
    // The plan reaching the cache is not the point — the DECK reads the
    // published view to decide whether to mount a terminal at all. A resume
    // filled the cache directly, so the ordinary plan sweep short-circuited
    // and nothing ever republished: the agent ran behind a permanent
    // "Waking up…" card, with no terminal attached to hear it exit.
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await settle();

    expect(pty.acquired.map((a) => a.paneId)).toEqual(["pane-1"]);
    expect(agentRun.specs["pane-1"]).toBeDefined();
  });

  it("spawns the resume plan's OWN argv, not a bare fresh agent", async () => {
    // The orchestrator took this step over from the terminal, so the pane's
    // plan and the process it starts are now one owner's business. A spawn
    // that dropped the args would start a DIFFERENT conversation and let its
    // reporter overwrite the binding — the substitution the manual origin
    // exists to prevent, invisible to every assertion on the cache.
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await settle();

    expect(pty.acquired[0]).toMatchObject({
      paneId: "pane-1",
      args: ["--resume", "s-1"],
      cwd: "/repo",
    });
  });

  it("a recorded binding is TRUSTED and resumed — no store is read", async () => {
    // The binding came from the pane's own process (the reporter posts at
    // session creation), so it existed; a session deleted since fails the
    // resume VISIBLY in the terminal — accepted, rare, uniform. The app
    // never opens an agent's session store.
    act(() => deck.hydrate(restored({ session: { id: "old", boundAt: "t" } })));
    await settle();

    expect(pane().idle).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual(["--resume", "old"]);
    expect(pane().session).toEqual({ id: "old", boundAt: "t" });
    expect(vi.mocked(buildResumeSpec)).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      {
        paneId: "pane-1",
        workspace: {
          id: "ws-1",
          instance: deck.workspaces[0].instance,
        },
        cwd: "/repo",
        branch: undefined,
        yolo: undefined,
        stagedSkills: expect.any(Function),
        mcpAccess: expect.any(Function),
      },
      expect.anything(),
      "old",
      "restore",
    );
    const calls = vi.mocked(buildResumeSpec).mock.calls;
    await calls[calls.length - 1][2].stagedSkills?.();
    expect(skillsAsked).toHaveBeenCalledWith(
      { id: "ws-1", instance: deck.workspaces[0].instance },
      undefined,
    );
  });

  it("an unbound pane starts FRESH — never matched by directory", async () => {
    // Every agent reports its id post-hoc now, so an unbound pane is normal
    // (never messaged, a mid-TUI /new, or a reporter that couldn't arm).
    // Matching the newest session in the pane's cwd would resume a FOREIGN
    // conversation whenever panes share a cwd (the default — a worktree is
    // optional): unbound wakes fresh, with no resume spec.
    act(() => deck.hydrate(restored({ agentType: "codex", cwd: "/repo" })));
    await settle();

    expect(pane().idle).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual([]);
  });

  it("a REMOTE pane wakes fresh — no directory probe, no resume", async () => {
    // A remote pane runs against a VPS endpoint: it has no local dir to probe
    // and is fresh-session only, so even a stale binding is ignored.
    ipc.probeWorktree.mockClear();
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    act(() =>
      deck.hydrate(
        restored({
          agentType: "codex",
          remoteEndpoint: "ws://vps:4500",
          session: { id: "stale", boundAt: "t" },
        }),
      ),
    );
    await settle();

    expect(pane().idle).toBeUndefined();
    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });

  it("an agent no plugin provides stays idle — and KEEPS its binding", async () => {
    act(() =>
      deck.hydrate(
        restored({ agentType: "gemini", session: { id: "old", boundAt: "t" } }),
      ),
    );
    await settle();

    expect(pane().idle).toEqual({ reason: "waking", origin: "restore" });
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
    expect(pane().session).toEqual({ id: "old", boundAt: "t" });
  });

  it("nothing wakes before the catalog is ready", async () => {
    catalog.ready = false;
    act(() => root.unmount());
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
    act(() => deck.hydrate(restored({})));
    await settle();

    expect(pane().idle).toEqual({ reason: "waking", origin: "restore" });
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });

  it("a gone directory blocks revival instead of spawning into nowhere", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(restored({ cwd: "/repo/wt-gone" })));
    await settle();

    expect(pane().idle).toEqual({ reason: "waking", origin: "restore" });
    expect(agentRun.blocked["pane-1"]).toBe("/repo/wt-gone");
  });

  it("closing a blocked pane reaps its blocked entry", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(restored({ cwd: "/repo/wt-gone" })));
    await settle();
    expect(agentRun.blocked["pane-1"]).toBe("/repo/wt-gone");

    act(() => deck.closeAgent("ws-1", "pane-1"));
    await settle();
    expect(agentRun.blocked).toEqual({});
  });
});

describe("agent orchestrator —resuming a suspended pane", () => {
  let root: Root;

  const withPane = (pane: object = {}): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-1",
            agentType: "claude",
            cwd: "/repo/wt-1",
            branch: "kd/ws/1",
            session: { id: "s-1", boundAt: "t" },
            idle: { reason: "suspended", at: "2026-07-25T09:00:00.000Z" },
            ...pane,
          },
        ],
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const pane = () => deck.workspaces[0].panes[0];

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("stays put until asked — the sweep never wakes it on its own", async () => {
    act(() => deck.hydrate(withPane()));
    await settle();

    expect(pane().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T09:00:00.000Z",
    });
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });

  it("resumes into its worktree with its recorded session", async () => {
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    expect(pane().idle).toBeUndefined();
    expect(ipc.probeWorktree).toHaveBeenCalledWith("/repo/wt-1");
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual(["--resume", "s-1"]);
  });

  it("builds the resume plan as MANUAL — a rejected id must not silently start a new conversation", async () => {
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    expect(vi.mocked(buildResumeSpec)).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      expect.anything(),
      expect.anything(),
      "s-1",
      "manual",
    );
  });

  it("a resume whose plan cannot be BUILT stays stopped instead of starting a new conversation", async () => {
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    expect(pane().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T09:00:00.000Z",
    });
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined();
    expect(agentRun.wakeFailed["pane-1"]).toContain("resume plan");
  });

  it("a BOOT restore whose plan cannot be built still degrades to a fresh wake", async () => {
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);
    act(() =>
      deck.hydrate(withPane({ idle: { reason: "waking", origin: "restore" } })),
    );
    await settle();

    expect(pane().idle).toBeUndefined();
    expect(agentRun.wakeFailed["pane-1"]).toBeUndefined();
  });

  it("a resume whose resume.plan THROWS is treated the same way", async () => {
    vi.mocked(buildResumeSpec).mockRejectedValueOnce(new Error("hook exploded"));
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    expect(pane().idle).toMatchObject({ reason: "suspended" });
    expect(agentRun.wakeFailed["pane-1"]).toContain("hook exploded");
  });

  it("asking again clears the last refusal", async () => {
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);
    act(() => deck.hydrate(withPane()));
    await settle();
    act(() => agentRun.resume("ws-1", "pane-1"));
    await settle();
    expect(agentRun.wakeFailed["pane-1"]).toBeDefined();

    act(() => agentRun.resume("ws-1", "pane-1"));
    await settle();

    expect(agentRun.wakeFailed["pane-1"]).toBeUndefined();
    expect(pane().idle).toBeUndefined();
  });

  it("a pane RESTORED at launch still builds as restore — only a click is manual", async () => {
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    act(() =>
      deck.hydrate(withPane({ idle: { reason: "waking", origin: "restore" } })),
    );
    await settle();

    expect(vi.mocked(buildResumeSpec)).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      expect.anything(),
      expect.anything(),
      "s-1",
      "restore",
    );
  });

  it("a DELETED worktree blocks the resume instead of spawning into nowhere", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    expect(pane().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T09:00:00.000Z",
    });
    expect(agentRun.blocked["pane-1"]).toBe("/repo/wt-1");
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined();
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
  });

  it("blocked once, probed once — a wedged pane never loops on the sweep", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(withPane()));
    await settle();
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();
    await settle();

    expect(ipc.probeWorktree).toHaveBeenCalledTimes(1);
  });

  it("start-fresh relocates it to the workspace folder — and DROPS the session", async () => {
    ipc.probeWorktree.mockImplementation((dir: string) =>
      Promise.resolve({
        exists: dir === "/repo",
        isWorktree: false,
        empty: false,
        branch: null,
      }),
    );
    act(() => deck.hydrate(withPane()));
    await settle();
    act(() => agentRun.resume("ws-1", "pane-1"));
    await settle();

    act(() => agentRun.startFresh("ws-1", "pane-1"));
    await settle();

    expect(agentRun.blocked).toEqual({});
    expect(pane().idle).toBeUndefined();
    expect(pane().cwd).toBeUndefined();
    expect(pane().branch).toBeUndefined();
    expect(pane().session).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual([]);
  });
});
