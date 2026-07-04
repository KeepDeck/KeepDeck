// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/workspaces";
import { useAgentDialog } from "./useAgentDialog";
import type { Deck } from "./useDeck";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The hook reaches the backend for repo inspection and name suggestions; pin
// both (suggestions follow the real Rust naming: kd/<ws>/<i> ↔ kd-<ws>-<i>).
vi.mock("../ipc/worktree", () => ({
  inspectRepo: async () => ({ isRepo: true, head: "abc", branch: "main" }),
  suggestWorktree: async (workspace: string, index: number) => ({
    branch: `kd/${workspace}/${index}`,
    folder: `kd-${workspace}-${index}`,
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
    flow = useAgentDialog(deck, [], "claude");
    return null;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
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

  it("without a base folder the path stays empty but a branch is still suggested", async () => {
    const ws = workspace({ worktreeBaseDir: null });
    await mount(ws);
    await act(async () => flow.openFor(ws));
    expect(flow.dialog?.suggestedPath).toBe("");
    expect(flow.dialog?.suggestedBranch).toBe("kd/KeepDeck/1");
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
});
