import { describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Workspace } from "../domain/deck";
import { createDeckActions } from "./deckActions";
import { createDeckStore } from "./deckStore";

const workspace = (id: string): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
});

describe("the sealed journal title", () => {
  /** A deck with one bound pane whose terminal title is decorated. */
  function boundDeck(titleAgents: () => { id: string; label: string; titleGlyphs?: string[] }[]) {
    const store = createDeckStore(undefined, titleAgents);
    const actions = createDeckActions(store);
    store.dispatch({
      type: "createWorkspace",
      workspace: { ...workspace("ws-1"), panes: [{ id: "pane-1", agentType: "glyphs", autoTitle: "✶ fixing auth" }] },
      at: "2026-01-01T00:00:00.000Z",
    });
    actions.setPaneSession("ws-1", "pane-1", { id: "s-1", boundAt: "2026-01-01T00:00:00.000Z" });
    const sealedTitle = () =>
      store.getSnapshot().journal.records["ws-1"].find((record) => record.sessionId === "s-1")?.title;
    return { actions, sealedTitle };
  }
  const catalog = () => [{ id: "glyphs", label: "Glyphs", titleGlyphs: ["✶"] }];

  it("is what the header showed when the pane closed — cleaned by the catalog the store reads", () => {
    const { actions, sealedTitle } = boundDeck(catalog);
    actions.closeAgent("ws-1", "pane-1");
    expect(sealedTitle()).toBe("fixing auth");
  });

  it("is what the header showed when the session switched", () => {
    const { actions, sealedTitle } = boundDeck(catalog);
    actions.setPaneSession("ws-1", "pane-1", { id: "s-2", boundAt: "2026-01-01T00:00:01.000Z" });
    expect(sealedTitle()).toBe("fixing auth");
  });

  it("keeps the decoration for an agent the catalog does not decorate", () => {
    const { actions, sealedTitle } = boundDeck(() => []);
    actions.closeAgent("ws-1", "pane-1");
    expect(sealedTitle()).toBe("✶ fixing auth");
  });
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

describe("createDeckActions", () => {
  it("hands the same set back for one store", () => {
    // Two long-lived callers ask for it — the orchestrator and the hook — and
    // the doc has always promised one set per store. An action that grows
    // per-instance state would otherwise silently become two behaviours.
    const store = createDeckStore();
    expect(createDeckActions(store)).toBe(createDeckActions(store));
  });

  it("keeps two stores apart — each set dispatches to its OWN", () => {
    // Not just "different objects": any non-memoized factory satisfies that.
    // What matters is that the cache cannot hand one store's actions to the
    // other, which is the whole risk of keying by identity.
    const first = createDeckStore();
    const second = createDeckStore();
    createDeckActions(first).createWorkspace(workspace("ws-1"));

    expect(first.getSnapshot().workspaces.map((w) => w.id)).toEqual(["ws-1"]);
    expect(second.getSnapshot().workspaces).toEqual([]);
  });
});
