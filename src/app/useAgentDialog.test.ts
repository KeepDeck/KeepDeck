// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDialogResult } from "../domain/agents";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { inspectRepo } from "../ipc/worktree";
import { useAgentDialog } from "./useAgentDialog";
import { AppRuntimeProvider } from "./runtimeContext";
import type { AppRuntime } from "./runtime";
import type {
  CreatePaneOutcome,
  CreatePaneRequest,
} from "./agentOrchestrator";
import type { Deck } from "./useDeck";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Per-path disk probes for suggestion filtering: paths in the map probe as a
// non-empty non-worktree dir (blocked); anything else as missing (free).
const blockedDirs = vi.hoisted(() => new Set<string>());

// The hook reaches the backend for repo inspection, name suggestions and path
// probes; pin all three (suggestions follow the real Rust naming:
// kd/<ws>/<i> ↔ kd-<ws>-<i>).
vi.mock("../ipc/worktree", () => ({
  inspectRepo: vi.fn(async () => ({
    isRepo: true,
    head: "abc",
    branch: "main",
  })),
  suggestWorktree: async (workspace: string, index: number) => ({
    branch: `kd/${workspace}/${index}`,
    folder: `kd-${workspace}-${index}`,
  }),
  probeWorktree: async (path: string) => ({
    exists: blockedDirs.has(path),
    isWorktree: false,
    empty: false,
    branch: null,
  }),
  createWorktree: async () => {
    throw new Error("not under test");
  },
  removeWorktree: async () => {},
}));

const workspace = (over: Partial<Workspace>): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "KeepDeck",
  cwd: "/repo",
  worktreeBaseDir: "/base",
  panes: [],
  ...over,
});

/** The one owner of what a new pane's arrival entails, as this hook sees it.
 * Requests are recorded, not landed: what the dialog OFFERS is this file's
 * subject; what the orchestrator then does with it is its own. */
const createPane = vi.fn<(request: CreatePaneRequest) => CreatePaneOutcome>(
  () => ({ kind: "created" }),
);
/** The continuations the dialog's "Start from" routes into. Recorded here
 * too: this file's subject is the ROUTING — which continuation, with which
 * target — and what each one then does is the orchestrator's own test. */
const resumeSession = vi.fn(() => Promise.resolve());
const forkSession = vi.fn(() => Promise.resolve());
const runtime = {
  orchestrator: { createPane, resumeSession, forkSession },
} as unknown as AppRuntime;
/** Where a failed continuation reports. A dialog that just closes on a failed
 * fork reads as success, so the wiring is worth asserting. */
const notices = { onResumeFailed: vi.fn(), onForkFailed: vi.fn() };
/** What the dialog asked for on its `n`th confirm. */
const offered = (n = 0) => createPane.mock.calls[n][0];
const mountHost = (
  root: Root,
  Host: (props: { deck: Deck }) => null,
  deck: Deck,
) =>
  root.render(
    createElement(AppRuntimeProvider, { runtime }, createElement(Host, { deck })),
  );

describe("useAgentDialog suggestions", () => {
  let host: HTMLElement;
  let root: Root;
  let flow: ReturnType<typeof useAgentDialog>;

  function Host({ deck }: { deck: Deck }) {
    // No settings store seeded here: the default-agent preference falls back
    // to "claude" — these tests cover suggestions, not the type picker.
    // No journal routing and no blocked panes: these tests cover suggestions.
    flow = useAgentDialog(deck, [], notices, {});
    return null;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    blockedDirs.clear();
    createPane.mockClear();
    vi.mocked(inspectRepo).mockReset().mockResolvedValue({
      isRepo: true,
      head: "abc",
      branch: "main",
    });
  });
  afterEach(() => act(() => root.unmount()));

  const mount = async (ws: Workspace) => {
    const deck = { workspaces: [ws], addAgentPane: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    return deck;
  };

  it("prefills the first suggestion NOT held by an open pane", async () => {
    // One pane → the naive suggestion is index 2, but a pane already runs in
    // kd-KeepDeck-2 (the reported bug): the prefill must skip to -3.
    const ws = workspace({
      panes: [{ id: "p1", cwd: "/base/kd-KeepDeck-2", branch: "kd/KeepDeck/2" }],
    });
    await mount(ws);
    await act(async () => flow.openFor(ws));
    expect(flow.dialog?.suggestedPath).toBe("/base/kd-KeepDeck-3");
    expect(flow.dialog?.suggestedBranch).toBe("kd/KeepDeck/3");
  });

  it("prefill also skips a dir blocked on disk (the leftover-folder bug)", async () => {
    // No pane holds kd-KeepDeck-1, but the folder exists with files (e.g. a
    // worktree removed outside the app): the prefill must not open the dialog
    // onto the blocked-path error — it skips to the first usable suggestion.
    blockedDirs.add("/base/kd-KeepDeck-1");
    const ws = workspace({});
    await mount(ws);
    await act(async () => flow.openFor(ws));
    expect(flow.dialog?.suggestedPath).toBe("/base/kd-KeepDeck-2");
    expect(flow.dialog?.suggestedBranch).toBe("kd/KeepDeck/2");
  });

  it("nextFree skips blocked dirs too", async () => {
    blockedDirs.add("/base/kd-KeepDeck-2");
    const ws = workspace({
      panes: [{ id: "p1", cwd: "/base/kd-KeepDeck-1", branch: "kd/KeepDeck/1" }],
    });
    await mount(ws);
    await act(async () => flow.openFor(ws));
    const free = await flow.nextFree("/base/kd-KeepDeck-1");
    expect(free).toEqual({
      path: "/base/kd-KeepDeck-3",
      branch: "kd/KeepDeck/3",
    });
  });

  it("without a base folder the path stays empty but a branch is still suggested", async () => {
    const ws = workspace({ worktreeBaseDir: null });
    await mount(ws);
    await act(async () => flow.openFor(ws));
    expect(flow.dialog?.suggestedPath).toBe("");
    expect(flow.dialog?.suggestedBranch).toBe("kd/KeepDeck/1");
  });

  it("branchFor maps a canonical folder to its canonical branch, else the folder name", async () => {
    const ws = workspace({});
    await mount(ws);
    await act(async () => flow.openFor(ws)); // branchFor works on the open dialog
    // The exact kd-<ws>-<n> shape resolves through the suggest IPC…
    expect(await flow.branchFor("/anywhere/kd-KeepDeck-7")).toBe("kd/KeepDeck/7");
    // …anything else — including a near-miss with a numeric tail — is taken
    // verbatim as the branch (the backend sanitizes at create time).
    expect(await flow.branchFor("/anywhere/fix-login")).toBe("fix-login");
    expect(await flow.branchFor("/anywhere/foo-3")).toBe("foo-3");
    expect(await flow.branchFor("")).toBeNull();
  });

  it("nextFree suggests beside the occupied path when the workspace has no base folder", async () => {
    const ws = workspace({
      worktreeBaseDir: null,
      panes: [{ id: "p1", cwd: "/elsewhere/kd-KeepDeck-2" }],
    });
    await mount(ws);
    await act(async () => flow.openFor(ws));
    const free = await flow.nextFree("/elsewhere/kd-KeepDeck-2");
    expect(free).toEqual({
      path: "/elsewhere/kd-KeepDeck-3",
      branch: "kd/KeepDeck/3",
    });
  });

  it("a picked base branch rides the pane's provisioning intent", async () => {
    const ws = workspace({});
    const deck = { workspaces: [ws] } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws));

    await act(async () => {
      flow.confirm({
        agentType: "claude",
        name: "",
        location: {
          kind: "new",
          path: "/base/kd-KeepDeck-1",
          branch: "kd/KeepDeck/1",
          baseBranch: "develop",
        },
        yolo: false,
      });
    });

    expect(createPane).toHaveBeenCalledTimes(1);
    expect(offered().pane.provisioning).toMatchObject({
      path: "/base/kd-KeepDeck-1",
      branch: "kd/KeepDeck/1",
      base: "develop",
    });
  });

  it("the YOLO choice lands on the pane — sparsely, only when armed", async () => {
    const ws = workspace({});
    const deck = { workspaces: [ws] } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));

    const confirmMain = async (yolo: boolean) => {
      await act(async () => flow.openFor(ws));
      await act(async () => {
        flow.confirm({
          agentType: "claude",
          name: "",
          location: { kind: "main" },
          yolo,
        });
      });
    };

    await confirmMain(true);
    expect(offered(0).pane.yolo).toBe(true);

    await confirmMain(false);
    // Off never lands as an explicit false — the pane stays sparse.
    expect("yolo" in offered(1).pane).toBe(false);
  });

  it("a remote result creates a bare pane carrying the endpoint (no cwd/location)", async () => {
    const ws = workspace({});
    const deck = { workspaces: [ws] } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));

    await act(async () => flow.openFor(ws));
    await act(async () => {
      flow.confirm({
        agentType: "codex",
        name: "vps agent",
        location: { kind: "main" },
        yolo: false,
        remoteEndpoint: "ws://vps:4500",
      });
    });

    expect(createPane).toHaveBeenCalledTimes(1);
    const pane = offered().pane;
    expect(pane).toMatchObject({ agentType: "codex", remoteEndpoint: "ws://vps:4500" });
    // Bare pane — no local cwd/provisioning (the agent's cwd is on the box).
    expect(pane.cwd).toBeUndefined();
    expect(pane.provisioning).toBeUndefined();
  });

  it("does not open after the workspace is replaced during repo inspection", async () => {
    const old = workspace({});
    let finishInspection!: (value: {
      isRepo: boolean;
      head: string;
      branch: string;
    }) => void;
    vi.mocked(inspectRepo).mockReturnValueOnce(
      new Promise((resolve) => {
        finishInspection = resolve;
      }),
    );
    await mount(old);

    let opening!: Promise<void>;
    await act(async () => {
      opening = flow.openFor(old);
      await Promise.resolve();
    });
    const replacement = workspace({ id: old.id });
    const replacementDeck = { workspaces: [replacement] } as unknown as Deck;
    await act(async () =>
      mountHost(root, Host, replacementDeck),
    );
    await act(async () => {
      finishInspection({ isRepo: true, head: "new", branch: "main" });
      await opening;
    });

    expect(flow.dialog).toBeNull();
  });

  it("does not confirm into a replacement with the same public id", async () => {
    const old = workspace({});
    const oldDeck = { workspaces: [old] } as unknown as Deck;
    await act(async () => mountHost(root, Host, oldDeck));
    await act(async () => flow.openFor(old));

    const replacement = workspace({ id: old.id });
    const replacementDeck = { workspaces: [replacement] } as unknown as Deck;
    await act(async () =>
      mountHost(root, Host, replacementDeck),
    );
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "",
        location: { kind: "main" },
        yolo: false,
      }),
    );

    // The dialog never even offers the pane: the workspace it opened for is
    // gone, and the one holding its id now is a different workspace.
    expect(createPane).not.toHaveBeenCalled();
  });
});

describe("useAgentDialog start-from routing", () => {
  let host: HTMLElement;
  let root: Root;
  let flow: ReturnType<typeof useAgentDialog>;


  const handle = {
    agent: "claude",
    sessionId: "s-1",
    cwd: "/repo/wt",
    title: "auth",
  };

  /** The revive sweep's gone-directory verdicts, as the hook receives them. */
  let blockedPanes: Record<string, string> = {};

  function Host({ deck }: { deck: Deck }) {
    flow = useAgentDialog(deck, [], notices, blockedPanes);
    return null;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    blockedPanes = {};
    createPane.mockClear();
    resumeSession.mockClear();
    forkSession.mockClear();
    notices.onResumeFailed.mockClear();
    notices.onForkFailed.mockClear();
  });
  afterEach(() => act(() => root.unmount()));

  const mountAndOpen = async (ws: Workspace) => {
    const deck = { workspaces: [ws] } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws));
  };

  it("resume routes to the journal flow with the pane name — the location is not consulted", async () => {
    const ws = workspace({});
    await mountAndOpen(ws);
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "  api  ",
        // A leftover location from before the mode switch — must be ignored.
        location: { kind: "new", path: "/x", branch: "b" },
        yolo: false,
        session: { mode: "resume", handle },
      }),
    );
    expect(resumeSession).toHaveBeenCalledExactlyOnceWith("ws-1", handle, {
      name: "api",
      yolo: false,
    });
    expect(forkSession).not.toHaveBeenCalled();
    expect(createPane).not.toHaveBeenCalled(); // the journal flow owns the pane
  });

  it("resume routes the YOLO choice to the journal flow", async () => {
    const ws = workspace({});
    await mountAndOpen(ws);
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "",
        // Resume ignores the location; only yolo + the handle ride.
        location: { kind: "main" },
        yolo: true,
        session: { mode: "resume", handle },
      }),
    );
    // The dialog already gates yolo on supportsYolo; confirm forwards the
    // resolved boolean verbatim — no re-gating in the handoff.
    expect(resumeSession).toHaveBeenLastCalledWith("ws-1", handle, {
      name: undefined,
      yolo: true,
    });
  });

  it("reports a failed resume — a dialog that just closes reads as success", async () => {
    const ws = workspace({});
    await mountAndOpen(ws);
    resumeSession.mockRejectedValueOnce(new Error("Agent could not prepare a resume plan"));
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "",
        location: { kind: "main" },
        yolo: false,
        session: { mode: "resume", handle },
      }),
    );
    expect(notices.onResumeFailed).toHaveBeenCalledWith(
      expect.stringContaining("could not prepare a resume plan"),
    );
    expect(notices.onForkFailed).not.toHaveBeenCalled();
  });

  it("reports a failed fork through its OWN notice, not the resume one", async () => {
    const ws = workspace({});
    await mountAndOpen(ws);
    forkSession.mockRejectedValueOnce(new Error("opencode fork: unexpected id layout"));
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "",
        location: { kind: "main" },
        yolo: false,
        session: { mode: "fork", handle },
      }),
    );
    expect(notices.onForkFailed).toHaveBeenCalledWith(
      expect.stringContaining("unexpected id layout"),
    );
    expect(notices.onResumeFailed).not.toHaveBeenCalled();
  });

  it("fork maps every location kind onto its ForkTarget", async () => {
    const ws = workspace({});
    const confirmFork = async (
      location: AgentDialogResult["location"],
    ) => {
      await act(async () => flow.openFor(ws));
      await act(async () =>
        flow.confirm({
          agentType: "claude",
          name: "",
          location,
          yolo: false,
          session: { mode: "fork", handle },
        }),
      );
    };
    await mountAndOpen(ws);

    await confirmFork({ kind: "main" });
    expect(forkSession).toHaveBeenLastCalledWith(
      "ws-1",
      handle,
      { kind: "dir", cwd: "/repo" },
      { name: undefined, yolo: false },
    );

    await confirmFork({ kind: "existing", path: "/wt/x", branch: "kd/x" });
    expect(forkSession).toHaveBeenLastCalledWith(
      "ws-1",
      handle,
      { kind: "dir", cwd: "/wt/x" },
      // The attached worktree's branch rides along — the pane owns it.
      { name: undefined, branch: "kd/x", yolo: false },
    );

    await confirmFork({
      kind: "new",
      path: "/base/kd-KeepDeck-1",
      branch: "kd/KeepDeck/1",
      baseBranch: "develop",
    });
    expect(forkSession).toHaveBeenLastCalledWith(
      "ws-1",
      handle,
      {
        kind: "worktree",
        path: "/base/kd-KeepDeck-1",
        branch: "kd/KeepDeck/1",
        base: "develop",
      },
      { name: undefined, yolo: false },
    );
  });

  it("fork routes the YOLO choice to the journal flow", async () => {
    const ws = workspace({});
    await mountAndOpen(ws);
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "",
        location: { kind: "main" },
        yolo: true,
        session: { mode: "fork", handle },
      }),
    );
    // The dialog already gates yolo on supportsYolo; confirm forwards the
    // resolved boolean verbatim — no re-gating in the handoff.
    expect(forkSession).toHaveBeenLastCalledWith(
      "ws-1",
      handle,
      { kind: "dir", cwd: "/repo" },
      { name: undefined, yolo: true },
    );
  });

  it("sessionClaim reads the panes' bindings, idle panes included", async () => {
    const ws = workspace({
      panes: [
        { id: "p1", session: { id: "s-run", boundAt: "2026-07-20T00:00:00Z" } },
        {
          id: "p2",
          idle: { reason: "suspended", at: "2026-07-20T01:00:00Z" },
          session: { id: "s-dorm", boundAt: "2026-07-20T00:00:00Z" },
        },
      ],
    });
    await mountAndOpen(ws);
    expect(flow.sessionClaim("s-run")).toBe("running");
    expect(flow.sessionClaim("s-dorm")).toBe("stopped");
    expect(flow.sessionClaim("s-free")).toBeNull();
  });

  it("calls a pane stuck on a gone folder stopped, like every other surface", async () => {
    // Its model marker still says `waking` — only the sweep's runtime verdict
    // knows the directory is gone. The tile is dimmed and the tray chip
    // marked, but the picker was telling the user the session is "running in
    // a pane" and offering nothing to do about it.
    blockedPanes = { p1: "/gone/worktree" };
    const ws = workspace({
      panes: [
        {
          id: "p1",
          idle: { reason: "waking", origin: "restore" },
          session: { id: "s-blocked", boundAt: "2026-07-20T00:00:00Z" },
        },
      ],
    });
    await mountAndOpen(ws);
    expect(flow.sessionClaim("s-blocked")).toBe("stopped");
  });

  it("still calls a pane merely on its way up running", async () => {
    const ws = workspace({
      panes: [
        {
          id: "p1",
          idle: { reason: "waking", origin: "restore" },
          session: { id: "s-rising", boundAt: "2026-07-20T00:00:00Z" },
        },
      ],
    });
    await mountAndOpen(ws);
    expect(flow.sessionClaim("s-rising")).toBe("running");
  });
});
