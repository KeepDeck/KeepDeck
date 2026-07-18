// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
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
  inspectRepo: async () => ({ isRepo: true, head: "abc", branch: "main" }),
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
});
