import { describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Workspace } from "../domain/deck";
import { createDeckStore } from "./deckStore";

const workspace = (id: string): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
});

describe("DeckStore", () => {
  it("applies actions synchronously and publishes the resulting snapshot", () => {
    const store = createDeckStore();
    const listener = vi.fn();
    store.subscribe(listener);

    const next = store.dispatch({
      type: "createWorkspace",
      workspace: workspace("ws-1"),
    });

    expect(store.getSnapshot()).toBe(next);
    expect(next.workspaces.map((ws) => ws.id)).toEqual(["ws-1"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not publish reducer no-ops", () => {
    const store = createDeckStore();
    const first = workspace("ws-1");
    store.dispatch({ type: "createWorkspace", workspace: first });
    const listener = vi.fn();
    store.subscribe(listener);

    const before = store.getSnapshot();
    const next = store.dispatch({
      type: "createWorkspace",
      workspace: workspace("ws-1"),
    });

    expect(next).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops publishing after unsubscribe", () => {
    const store = createDeckStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();

    store.dispatch({
      type: "createWorkspace",
      workspace: workspace("ws-1"),
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
