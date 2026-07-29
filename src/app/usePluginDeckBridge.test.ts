// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { AppRuntimeProvider } from "./runtimeContext";
import type { AppRuntime } from "./runtime";
import type { Deck } from "./useDeck";
import {
  closedWorkspaces,
  revealDockTabOn,
  usePluginDeckBridge,
} from "./usePluginDeckBridge";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
describe("usePluginDeckBridge pane-selected emission", () => {
  const workspace = (id: string) => ({
    id,
    instance: createWorkspaceInstance(),
    name: id,
    cwd: `/${id}`,
    panes: [],
    plugins: {},
  });

  function harness() {
    const emitted: Array<{ workspace: { id: string }; paneId: string | null }> =
      [];
    const runtime = {
      plugins: {
        pluginDeckEvents: {
          emitWorkspaceClosed: vi.fn(),
          emitDeckChanged: vi.fn(),
          emitPaneSelected: (e: {
            workspace: { id: string };
            paneId: string | null;
          }) => emitted.push(e),
        },
        wireDeckAccess: vi.fn(),
        wireDeckUi: vi.fn(),
      },
    } as unknown as AppRuntime;

    const host = document.createElement("div");
    const root = createRoot(host);
    const Probe = ({ deck }: { deck: Deck }) => {
      usePluginDeckBridge(deck);
      return null;
    };
    const render = async (deck: Deck) => {
      await act(async () => {
        root.render(
          createElement(
            AppRuntimeProvider,
            { runtime },
            createElement(Probe, { deck }),
          ),
        );
      });
    };
    return { emitted, render, unmount: () => act(async () => root.unmount()) };
  }

  const deckOf = (workspaces: ReturnType<typeof workspace>[], activeId: string) =>
    ({
      workspaces,
      activeId,
      viewOf: () => ({ select: null }),
      setWorkspacePluginSlot: vi.fn(),
      toggleDock: vi.fn(),
      setDockTab: vi.fn(),
    }) as unknown as Deck;

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
