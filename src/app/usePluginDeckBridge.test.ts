// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { DeckState, Workspace } from "../domain/deck";
import { deckState } from "../domain/deck/reducer.testSupport";
import {
  closedWorkspaces,
  createPluginDeckBridge,
  revealDockTabOn,
  type PluginDeckSide,
} from "./pluginDeckBridge";
import { createDeckStore } from "./deckStore";
import { createDeckActions } from "./deckActions";

const ref = (id: string, instance = createWorkspaceInstance()) => ({
  id,
  instance,
});

describe("closedWorkspaces", () => {
  it("names exactly the ids that disappeared", () => {
    const a = ref("a");
    const b = ref("b");
    const c = ref("c");
    expect(closedWorkspaces([a, b, c], [a, c])).toEqual([b]);
  });

  it("is empty on growth, reorder, and the first render", () => {
    const a = ref("a");
    const b = ref("b");
    expect(closedWorkspaces([], [a])).toEqual([]);
    expect(closedWorkspaces([a, b], [b, a, ref("c")])).toEqual([]);
  });

  it("reports several removals at once (multi-close on hydrate)", () => {
    const previous = [ref("a"), ref("b"), ref("c")];
    expect(closedWorkspaces(previous, [])).toEqual(previous);
  });

  it("reports the old lifetime when the same public id is reused", () => {
    const old = ref("ws-3");
    expect(closedWorkspaces([old], [ref("ws-3")])).toEqual([old]);
  });
});

describe("revealDockTabOn", () => {
  const deckWith = (dock: boolean | undefined, activeId = "ws-1") => ({
    activeId,
    viewOf: vi.fn(() => ({ dock })),
    toggleDock: vi.fn(),
    setDockTab: vi.fn(),
  });

  it("opens a closed dock, then selects the tab", () => {
    const deck = deckWith(undefined);
    revealDockTabOn(deck, "keepdeck.files:files");
    expect(deck.toggleDock).toHaveBeenCalledWith("ws-1");
    expect(deck.setDockTab).toHaveBeenCalledWith("ws-1", "keepdeck.files:files");
  });

  it("leaves an already-open dock alone — toggle would CLOSE it", () => {
    const deck = deckWith(true);
    revealDockTabOn(deck, "keepdeck.files:files");
    expect(deck.toggleDock).not.toHaveBeenCalled();
    expect(deck.setDockTab).toHaveBeenCalledWith("ws-1", "keepdeck.files:files");
  });

  it("does nothing without an active workspace", () => {
    const deck = deckWith(undefined, "");
    revealDockTabOn(deck, "t");
    expect(deck.toggleDock).not.toHaveBeenCalled();
    expect(deck.setDockTab).not.toHaveBeenCalled();
  });
});

/**
 * `onPaneSelected` is the only signal a RESIDENT plugin surface has for "the
 * user moved to another workspace" — it takes no props and the contract has no
 * deck reader. The git plugin's diff peek drops itself on it, and every test
 * over there fires the event through a fake context, so nothing but this
 * guards the emission itself: narrowing this effect's dependencies would leave
 * a full-window diff of the workspace the user left sitting over the one they
 * went to, with the whole suite green.
 */
describe("plugin deck bridge pane-selected emission", () => {
  const workspace = (id: string): Workspace => ({
    id,
    instance: createWorkspaceInstance(),
    name: id,
    cwd: `/${id}`,
    worktreeBaseDir: null,
    panes: [],
    plugins: {},
  });

  function harness() {
    const emitted: Array<{ workspace: { id: string }; paneId: string | null }> =
      [];
    const plugins: PluginDeckSide = {
      pluginDeckEvents: {
        emitWorkspaceClosed: vi.fn(),
        emitDeckChanged: vi.fn(),
        emitPaneSelected: (e) => {
          emitted.push(e);
        },
      },
      wireDeckAccess: vi.fn(),
      wireDeckUi: vi.fn(),
    };
    const store = createDeckStore();
    const actions = createDeckActions(store);
    const bridge = createPluginDeckBridge(store, plugins);
    const render = async (deck: DeckState) => {
      actions.hydrate(deck);
      await Promise.resolve();
    };
    return { emitted, render, unmount: () => bridge.dispose() };
  }

  /** A deck with nothing selected in any workspace. */
  const deckOf = (workspaces: Workspace[], activeId: string) =>
    deckState({ workspaces, activeId });

  it("fires when the ACTIVE WORKSPACE changes, naming the new one", async () => {
    const a = workspace("ws-a");
    const b = workspace("ws-b");
    const rig = harness();

    await rig.render(deckOf([a, b], a.id));
    expect(rig.emitted.map((e) => e.workspace.id)).toEqual(["ws-a"]);

    // Nothing about the selection changed — only which workspace is active.
    await rig.render(deckOf([a, b], b.id));

    expect(rig.emitted.map((e) => e.workspace.id)).toEqual(["ws-a", "ws-b"]);
    await rig.unmount();
  });

  it("does not re-fire when neither the active workspace nor the selection moved", async () => {
    const a = workspace("ws-a");
    const rig = harness();

    await rig.render(deckOf([a], a.id));
    await rig.render(deckOf([a], a.id));

    expect(rig.emitted).toHaveLength(1);
    await rig.unmount();
  });
});
