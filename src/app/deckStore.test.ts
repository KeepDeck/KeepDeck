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

    const next = store.dispatch({ type: "createWorkspace", workspace: workspace("ws-1"), at: "2026-01-01T00:00:00.000Z" });

    expect(store.getSnapshot()).toBe(next);
    expect(next.workspaces.map((ws) => ws.id)).toEqual(["ws-1"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not publish reducer no-ops", () => {
    const store = createDeckStore();
    const first = workspace("ws-1");
    store.dispatch({ type: "createWorkspace", workspace: first, at: "2026-01-01T00:00:00.000Z" });
    const listener = vi.fn();
    store.subscribe(listener);

    const before = store.getSnapshot();
    const next = store.dispatch({ type: "createWorkspace", workspace: workspace("ws-1"), at: "2026-01-01T00:00:00.000Z" });

    expect(next).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops publishing after unsubscribe", () => {
    const store = createDeckStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();

    store.dispatch({ type: "createWorkspace", workspace: workspace("ws-1"), at: "2026-01-01T00:00:00.000Z" });

    expect(listener).not.toHaveBeenCalled();
  });
});
