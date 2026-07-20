// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDialogResult } from "../domain/agents";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { inspectRepo } from "../ipc/worktree";
import { useAgentDialog } from "./useAgentDialog";
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

describe("useAgentDialog suggestions", () => {
  let host: HTMLElement;
  let root: Root;
  let flow: ReturnType<typeof useAgentDialog>;

  function Host({ deck }: { deck: Deck }) {
    // No settings store seeded here: the default-agent preference falls back
    // to "claude" — these tests cover suggestions, not the type picker.
    flow = useAgentDialog(deck, []);
    return null;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    blockedDirs.clear();
    vi.mocked(inspectRepo).mockReset().mockResolvedValue({
      isRepo: true,
      head: "abc",
      branch: "main",
    });
  });
  afterEach(() => act(() => root.unmount()));

  const mount = async (ws: Workspace) => {
    const deck = { workspaces: [ws], addAgentPane: vi.fn() } as unknown as Deck;
    await act(async () => root.render(createElement(Host, { deck })));
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
    // The full provisioning sink: confirm fires runProvisioning in the
    // background, and its (here-failing, createWorktree is pinned to throw)
    // result must land in a real callback, not crash the test.
    const deck = {
      workspaces: [ws],
      addAgentPane: vi.fn(),
      resolvePaneProvisioning: vi.fn(),
      setPaneProvisioningError: vi.fn(),
      setPaneProvisioningPhase: vi.fn(),
    } as unknown as Deck;
    await act(async () => root.render(createElement(Host, { deck })));
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

    const addAgentPane = deck.addAgentPane as ReturnType<typeof vi.fn>;
    expect(addAgentPane).toHaveBeenCalledTimes(1);
    expect(addAgentPane.mock.calls[0][1].provisioning).toMatchObject({
      path: "/base/kd-KeepDeck-1",
      branch: "kd/KeepDeck/1",
      base: "develop",
    });
  });

  it("the YOLO choice lands on the pane — sparsely, only when armed", async () => {
    const ws = workspace({});
    const addAgentPane = vi.fn();
    const deck = { workspaces: [ws], addAgentPane } as unknown as Deck;
    await act(async () => root.render(createElement(Host, { deck })));

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
    expect(addAgentPane.mock.calls[0][1].yolo).toBe(true);

    await confirmMain(false);
    // Off never lands as an explicit false — the pane stays sparse.
    expect("yolo" in addAgentPane.mock.calls[1][1]).toBe(false);
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
    const replacementDeck = {
      workspaces: [replacement],
      addAgentPane: vi.fn(),
    } as unknown as Deck;
    await act(async () =>
      root.render(createElement(Host, { deck: replacementDeck })),
    );
    await act(async () => {
      finishInspection({ isRepo: true, head: "new", branch: "main" });
      await opening;
    });

    expect(flow.dialog).toBeNull();
  });

  it("does not confirm into a replacement with the same public id", async () => {
    const old = workspace({});
    const oldAdd = vi.fn();
    const oldDeck = {
      workspaces: [old],
      addAgentPane: oldAdd,
    } as unknown as Deck;
    await act(async () => root.render(createElement(Host, { deck: oldDeck })));
    await act(async () => flow.openFor(old));

    const replacement = workspace({ id: old.id });
    const replacementAdd = vi.fn();
    const replacementDeck = {
      workspaces: [replacement],
      addAgentPane: replacementAdd,
    } as unknown as Deck;
    await act(async () =>
      root.render(createElement(Host, { deck: replacementDeck })),
    );
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "",
        location: { kind: "main" },
        yolo: false,
      }),
    );

    expect(oldAdd).not.toHaveBeenCalled();
    expect(replacementAdd).not.toHaveBeenCalled();
  });
});

describe("useAgentDialog start-from routing", () => {
  let host: HTMLElement;
  let root: Root;
  let flow: ReturnType<typeof useAgentDialog>;

  const journal = { resume: vi.fn(), fork: vi.fn() };
  const handle = {
    agent: "claude",
    sessionId: "s-1",
    cwd: "/repo/wt",
    title: "auth",
  };

  function Host({ deck }: { deck: Deck }) {
    flow = useAgentDialog(deck, [], journal);
    return null;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    journal.resume.mockClear();
    journal.fork.mockClear();
  });
  afterEach(() => act(() => root.unmount()));

  const mountAndOpen = async (ws: Workspace, addAgentPane = vi.fn()) => {
    const deck = { workspaces: [ws], addAgentPane } as unknown as Deck;
    await act(async () => root.render(createElement(Host, { deck })));
    await act(async () => flow.openFor(ws));
    return addAgentPane;
  };

  it("resume routes to the journal flow with the pane name — the location is not consulted", async () => {
    const ws = workspace({});
    const addAgentPane = await mountAndOpen(ws);
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
    expect(journal.resume).toHaveBeenCalledExactlyOnceWith("ws-1", handle, {
      name: "api",
    });
    expect(journal.fork).not.toHaveBeenCalled();
    expect(addAgentPane).not.toHaveBeenCalled(); // the flow owns the pane
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
    expect(journal.fork).toHaveBeenLastCalledWith(
      "ws-1",
      handle,
      { kind: "dir", cwd: "/repo" },
      { name: undefined },
    );

    await confirmFork({ kind: "existing", path: "/wt/x", branch: "kd/x" });
    expect(journal.fork).toHaveBeenLastCalledWith(
      "ws-1",
      handle,
      { kind: "dir", cwd: "/wt/x" },
      // The attached worktree's branch rides along — the pane owns it.
      { name: undefined, branch: "kd/x" },
    );

    await confirmFork({
      kind: "new",
      path: "/base/kd-KeepDeck-1",
      branch: "kd/KeepDeck/1",
      baseBranch: "develop",
    });
    expect(journal.fork).toHaveBeenLastCalledWith(
      "ws-1",
      handle,
      {
        kind: "worktree",
        path: "/base/kd-KeepDeck-1",
        branch: "kd/KeepDeck/1",
        base: "develop",
      },
      { name: undefined },
    );
  });

  it("sessionClaim reads the panes' bindings, dormancy included", async () => {
    const ws = workspace({
      panes: [
        { id: "p1", session: { id: "s-run", boundAt: "2026-07-20T00:00:00Z" } },
        {
          id: "p2",
          dormant: true,
          session: { id: "s-dorm", boundAt: "2026-07-20T00:00:00Z" },
        },
      ],
    });
    await mountAndOpen(ws);
    expect(flow.sessionClaim("s-run")).toBe("running");
    expect(flow.sessionClaim("s-dorm")).toBe("dormant");
    expect(flow.sessionClaim("s-free")).toBeNull();
  });
});
