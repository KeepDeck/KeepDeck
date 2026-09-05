// @vitest-environment happy-dom
import { provisioningCard } from "../../domain/deck";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PANES,
  Probe,
  agentRun,
  buildForkSpec,
  buildResumeSpec,
  catalog,
  createWorkspaceInstance,
  deck,
  gate,
  ipc,
  peekPaneSpawnSpec,
  provisions,
  pty,
  resetPaneSpawnSpecs,
  settle,
  skillsAsked,
  steps,
} from "./testSupport";
import type {
  SessionHandle,
} from "./testSupport";

/** One empty workspace to continue a session into. */
const emptyWorkspace = () =>
  act(() =>
    deck.createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws-1",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [],
    }),
  );

const handle = (over: Partial<SessionHandle> = {}): SessionHandle =>
  ({
    agent: "codex",
    sessionId: "s-1",
    cwd: "/repo/wt",
    branch: "kd/x/1",
    yolo: true,
    // The plugin's fork hook needs the SOURCE transcript; without it a fork
    // lands in an empty conversation with a wrong usage baseline.
    transcriptPath: "/t/s-1.jsonl",
    ...over,
  }) as SessionHandle;

const fillWorkspace = () =>
  act(() => {
    for (let i = 0; i < MAX_PANES; i++) {
      deck.addAgentPane("ws-1", { id: `p-${i}`, agentType: "claude" });
    }
  });

describe("agent orchestrator —continuing a recorded session", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    vi.mocked(buildResumeSpec).mockReset();
    skillsAsked.mockClear();
    gate.build = null;
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
    emptyWorkspace();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("mints a pane carrying the record's shape and a pre-claimed session", async () => {
    await act(async () => agentRun.resumeSession("ws-1", handle()));

    const panes = deck.workspaces[0].panes;
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({
      agentType: "codex",
      // A foreign dir → pinned to the session's worktree.
      location: { kind: "attached", cwd: "/repo/wt", branch: "kd/x/1" },
      yolo: true,
      session: { id: "s-1" },
    });
    // Built for that pane, as a MANUAL resume: a continuation the user asked
    // for must not quietly become a different conversation.
    expect(peekPaneSpawnSpec(panes[0].id)).toMatchObject({
      resumeOf: "s-1",
      resumeOrigin: "manual",
    });
  });

  it("leaves a session recorded in the workspace's OWN folder a plain pane", async () => {
    await act(async () =>
      agentRun.resumeSession("ws-1", handle({ cwd: "/repo", branch: undefined })),
    );
    expect(deck.workspaces[0].panes[0].location).toBeUndefined();
  });

  it("refuses a session another pane already holds, LOUDLY", async () => {
    // The browser offers Resume for every row — it cannot know lifecycle. An
    // enabled button that silently does nothing reads as dead.
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-77",
        agentType: "codex",
        session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
      }),
    );
    await expect(
      act(async () => agentRun.resumeSession("ws-1", handle())),
    ).rejects.toThrow("already running");
    expect(deck.workspaces[0].panes).toHaveLength(1);
    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
  });

  it("points at the pane that HOLDS the session when that pane is stopped", async () => {
    // "Already running" would be false and useless: the pane is stopped, and
    // the thing to do is resume it there, where its card has the button.
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-77",
        agentType: "codex",
        session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
      }),
    );
    act(() => deck.suspendPane("ws-1", "pane-77"));

    await expect(
      act(async () => agentRun.resumeSession("ws-1", handle())),
    ).rejects.toThrow("stopped pane");
  });

  it("calls a claimant stuck on a gone folder stopped, not running", async () => {
    // Its own marker still says `waking`; only the sweep's runtime verdict
    // knows it will never get there. Without that verdict the message sent
    // the user looking for a running agent that isn't.
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-77",
        agentType: "codex",
        location: { kind: "attached", cwd: "/gone/worktree" },
        session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
      }),
    );
    act(() => deck.suspendPane("ws-1", "pane-77"));
    act(() => deck.requestPaneWake("ws-1", "pane-77"));
    await settle();
    expect(agentRun.blocked).toEqual({ "pane-77": "/gone/worktree" });

    await expect(
      act(async () => agentRun.resumeSession("ws-1", handle())),
    ).rejects.toThrow("stopped pane");
  });

  it("is not blocked by a FORK of the same session — they are not alternatives", async () => {
    // A fork copies the session, a resume claims it. Sharing one guard let a
    // fork's store surgery — seconds of export/rekey/import — swallow the
    // Resume beside it: no pane, no error, a dead button.
    let release!: () => void;
    vi.mocked(buildForkSpec).mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve(true);
      }),
    );
    act(() => {
      void agentRun.forkSession("ws-1", handle(), { kind: "dir", cwd: "/x" });
    });

    await act(async () => agentRun.resumeSession("ws-1", handle()));
    expect(deck.workspaces[0].panes.some((p) => p.session?.id === "s-1")).toBe(
      true,
    );
    await act(async () => release());
  });

  it("rejects — and mints no pane — when the plan cannot be prepared", async () => {
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);
    await expect(
      act(async () => agentRun.resumeSession("ws-1", handle())),
    ).rejects.toThrow("resume plan");
    expect(deck.workspaces[0].panes).toHaveLength(0);
  });

  it("fails a full workspace loudly instead of stranding the built plan", async () => {
    fillWorkspace();
    await expect(
      act(async () => agentRun.resumeSession("ws-1", handle())),
    ).rejects.toThrow("full");
    expect(deck.workspaces[0].panes).toHaveLength(MAX_PANES);
  });

  it("re-checks the claim after the async build — a concurrent binder wins", async () => {
    let release!: () => void;
    gate.build = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending!: Promise<void>;
    act(() => {
      pending = agentRun.resumeSession("ws-1", handle());
    });
    // The session gets claimed DURING the build (a revive landed).
    act(() =>
      deck.addAgentPane("ws-1", {
        id: "pane-claimer",
        agentType: "claude",
        session: { id: "s-1", boundAt: "2026-07-19T00:00:00.000Z" },
      }),
    );
    await act(async () => {
      release();
      await pending;
    });
    // Only the claimer exists — no second pane bound to the same session.
    expect(deck.workspaces[0].panes.map((p) => p.id)).toEqual(["pane-claimer"]);
  });

  it("drops the built plan — and SAYS so — when the workspace died during the build", async () => {
    let release!: () => void;
    gate.build = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending!: Promise<void>;
    act(() => {
      pending = agentRun.resumeSession("ws-1", handle());
    });
    act(() => deck.closeWorkspace("ws-1"));
    await act(async () => {
      release();
      // Resolving here would tell the row's Resume it worked: no pane
      // appears, no alert fires, and the button reads as dead.
      await expect(pending).rejects.toThrow("closed");
    });

    expect(deck.workspaces).toHaveLength(0);
    // The plan finished building into a cache entry keyed by a pane that will
    // now never exist, and pane ids are never reused.
    const minted = vi.mocked(buildResumeSpec).mock.calls[0][2].paneId;
    expect(peekPaneSpawnSpec(minted)).toBeUndefined();
  });

  it("asks about the recorded session's OWN directory as the landing cwd", async () => {
    await act(async () => agentRun.resumeSession("ws-1", handle()));

    const calls = vi.mocked(buildResumeSpec).mock.calls;
    const facts = calls[calls.length - 1][2];
    await facts.stagedSkills?.();
    expect(skillsAsked).toHaveBeenCalledWith(
      { id: "ws-1", instance: deck.workspaces[0].instance },
      facts.cwd,
    );
  });

  it("a YOLO override reaches the pane AND the plan's facts", async () => {
    await act(async () =>
      agentRun.resumeSession("ws-1", handle({ yolo: false }), { yolo: true }),
    );
    expect(deck.workspaces[0].panes[0].yolo).toBe(true);
    expect(vi.mocked(buildResumeSpec).mock.calls[0][2]).toMatchObject({
      yolo: true,
    });
  });

  it("a YOLO override=false disarms a resume of a YOLO source session", async () => {
    await act(async () =>
      agentRun.resumeSession("ws-1", handle({ yolo: true }), { yolo: false }),
    );
    expect(deck.workspaces[0].panes[0].yolo).toBeUndefined();
    expect(vi.mocked(buildResumeSpec).mock.calls[0][2]).toMatchObject({
      yolo: false,
    });
  });
});

describe("agent orchestrator —forking a recorded session", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    vi.mocked(buildForkSpec).mockClear();
    steps.register.mockClear();
    steps.clear.mockClear();
    skillsAsked.mockClear();
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
    emptyWorkspace();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const forked = () => handle({ agent: "claude", cwd: "/old/wt", yolo: false });
  /** The step registered for the pane, as the worktree runner would call it. */
  const registeredStep = () =>
    steps.register.mock.calls[0][1] as (wt: {
      cwd: string;
      branch: string;
    }) => Promise<void>;

  it("dir target: mints an UNBOUND pane in the chosen dir with the fork plan", async () => {
    await act(async () =>
      agentRun.forkSession("ws-1", forked(), { kind: "dir", cwd: "/elsewhere" }),
    );

    const pane = deck.workspaces[0].panes[0];
    expect(pane).toMatchObject({
      agentType: "claude",
      location: { kind: "attached", cwd: "/elsewhere" },
    });
    // The fork's NEW session id arrives later, via the reporter.
    expect(pane.session).toBeUndefined();
    const call = vi.mocked(buildForkSpec).mock.calls[0];
    expect(call[2]).toMatchObject({ paneId: pane.id, cwd: "/elsewhere" });
    await call[2].stagedSkills?.();
    expect(skillsAsked).toHaveBeenCalledWith(
      { id: "ws-1", instance: deck.workspaces[0].instance },
      "/elsewhere",
    );
    // Exact, not a subset: an extra or renamed field in the fork request is
    // as much a defect as a missing one.
    expect(call[4]).toEqual({
      sessionId: "s-1",
      sourceCwd: "/old/wt",
      transcriptPath: "/t/s-1.jsonl",
    });
  });

  it("the workspace's own folder stays a plain pane", async () => {
    await act(async () =>
      agentRun.forkSession("ws-1", forked(), { kind: "dir", cwd: "/repo" }),
    );
    expect(deck.workspaces[0].panes[0].location).toBeUndefined();
  });

  it("worktree target: a card first, and the surgery DEFERRED to a step", async () => {
    await act(async () =>
      agentRun.forkSession("ws-1", handle({ agent: "claude", yolo: true }), {
        kind: "worktree",
        path: "/repo-wt/fork-1",
        branch: "fork/auth",
      }),
    );

    const pane = deck.workspaces[0].panes[0];
    expect(provisioningCard(pane)).toMatchObject({
      intent: { repo: "/repo", path: "/repo-wt/fork-1", branch: "fork/auth" },
    });
    // The marker the whole restart-safety fix hinges on: serialize drops it.
    expect(provisioningCard(pane)?.fork).toBe(true);
    expect(pane.yolo).toBe(true);
    // The worktree does not exist yet, so no surgery runs up front — a step
    // is registered and the ordinary create is kicked off behind the card.
    expect(vi.mocked(buildForkSpec)).not.toHaveBeenCalled();
    expect(steps.register).toHaveBeenCalledTimes(1);
    expect(steps.register.mock.calls[0][0]).toBe(pane.id);
    expect(provisions).toHaveLength(1);
    expect(provisions[0].map((p) => p.id)).toEqual([pane.id]);

    // The step runs the surgery bound to the CREATED worktree's cwd —
    // deliberately DISTINCT from the requested path, proving it uses the
    // runner's answer and not the stale target.
    await registeredStep()({
      cwd: "/repo-wt/fork-1-created",
      branch: "fork/auth",
    });
    expect(vi.mocked(buildForkSpec).mock.calls[0][2]).toMatchObject({
      paneId: pane.id,
      cwd: "/repo-wt/fork-1-created",
    });
  });

  it("worktree target: the step THROWS when the surgery cannot prepare", async () => {
    vi.mocked(buildForkSpec).mockResolvedValueOnce(false);
    await act(async () =>
      agentRun.forkSession("ws-1", forked(), {
        kind: "worktree",
        path: "/repo-wt/f",
        branch: "fork/x",
      }),
    );
    // The runner relies on the throw to roll the worktree back and fail the
    // card (asserted in provisioning.test.ts); here: the step signals it.
    await expect(
      registeredStep()({ cwd: "/repo-wt/f", branch: "fork/x" }),
    ).rejects.toThrow("Agent could not prepare a fork plan");
  });

  it("worktree target: the step carries the plugin's OWN diagnostic through", async () => {
    vi.mocked(buildForkSpec).mockRejectedValueOnce(
      new Error("opencode fork: unexpected id layout"),
    );
    await act(async () =>
      agentRun.forkSession("ws-1", forked(), {
        kind: "worktree",
        path: "/repo-wt/f",
        branch: "fork/x",
      }),
    );
    // No masking try/catch, so the runner surfaces the precise message
    // instead of the generic one.
    await expect(
      registeredStep()({ cwd: "/repo-wt/f", branch: "fork/x" }),
    ).rejects.toThrow("unexpected id layout");
  });

  it("a full workspace fails loudly — no stranded step, no ownerless worktree", async () => {
    fillWorkspace();
    await expect(
      act(async () =>
        agentRun.forkSession("ws-1", forked(), {
          kind: "worktree",
          path: "/repo-wt/f",
          branch: "fork/x",
        }),
      ),
    ).rejects.toThrow("full");
    expect(provisions).toEqual([]);
    // The step was registered before the refusal; leaving it in the map would
    // hold a closure over a pane id that will never exist again.
    expect(steps.clear).toHaveBeenCalledTimes(1);
  });

  it("a full workspace fails a DIR fork BEFORE the irreversible surgery", async () => {
    fillWorkspace();
    await expect(
      act(async () =>
        agentRun.forkSession("ws-1", forked(), { kind: "dir", cwd: "/elsewhere" }),
      ),
    ).rejects.toThrow("full");
    // export→rekey→import never runs, so there is no orphan clone.
    expect(vi.mocked(buildForkSpec)).not.toHaveBeenCalled();
  });

  it("reports the closed workspace instead of orphaning the clone it just made", async () => {
    // The surgery is irreversible — export→rekey→import into the agent's own
    // store — and it has already run by the time the pane lands. A workspace
    // closing inside that await used to resolve the promise as if the fork
    // had worked: a cloned session left in the store forever, no pane, no
    // error, and a dialog that closed on success.
    let release!: () => void;
    vi.mocked(buildForkSpec).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(true);
        }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = agentRun.forkSession("ws-1", forked(), {
        kind: "dir",
        cwd: "/elsewhere",
      });
    });
    act(() => deck.closeWorkspace("ws-1"));
    await act(async () => {
      release();
      await expect(pending).rejects.toThrow("closed");
    });

    expect(vi.mocked(buildForkSpec)).toHaveBeenCalledOnce();
    expect(deck.workspaces).toHaveLength(0);
  });

  it("a throwing surgery carries its precise diagnostic to the caller", async () => {
    vi.mocked(buildForkSpec).mockRejectedValueOnce(
      new Error("kimi fork of s-1: unexpected store layout"),
    );
    await expect(
      act(async () =>
        agentRun.forkSession("ws-1", forked(), { kind: "dir", cwd: "/x" }),
      ),
    ).rejects.toThrow("unexpected store layout");
    expect(deck.workspaces[0].panes).toHaveLength(0);
  });

  it("rejects — and mints nothing — when the surgery cannot prepare a plan", async () => {
    vi.mocked(buildForkSpec).mockResolvedValueOnce(false);
    await expect(
      act(async () =>
        agentRun.forkSession("ws-1", forked(), { kind: "dir", cwd: "/x" }),
      ),
    ).rejects.toThrow("fork plan");
    expect(deck.workspaces[0].panes).toHaveLength(0);
    expect(provisions).toEqual([]);
  });

  it("a YOLO override reaches the pane AND the plan's facts", async () => {
    await act(async () =>
      agentRun.forkSession(
        "ws-1",
        forked(),
        { kind: "dir", cwd: "/x" },
        { yolo: true },
      ),
    );
    expect(deck.workspaces[0].panes[0].yolo).toBe(true);
    expect(vi.mocked(buildForkSpec).mock.calls[0][2]).toMatchObject({
      yolo: true,
    });
  });

  it("a YOLO override=false disarms a fork of a YOLO source session", async () => {
    await act(async () =>
      agentRun.forkSession(
        "ws-1",
        handle({ agent: "claude", yolo: true }),
        { kind: "dir", cwd: "/x" },
        { yolo: false },
      ),
    );
    expect(deck.workspaces[0].panes[0].yolo).toBeUndefined();
    expect(vi.mocked(buildForkSpec).mock.calls[0][2]).toMatchObject({
      yolo: false,
    });
  });
});
