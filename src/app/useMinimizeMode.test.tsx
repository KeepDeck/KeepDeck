// @vitest-environment happy-dom
import { emptyJournal } from "../domain/journal";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeckLayout, MinimizeStyle } from "../domain/settings";
import type { DeckState } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { useDeck, type Deck } from "./useDeck";
import { createDeckStore } from "./deckStore";
import { useMinimizeMode } from "./useMinimizeMode";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("useMinimizeMode", () => {
  let container: HTMLDivElement;
  let root: Root;
  let deck: Deck;

  function Harness({
    deckLayout,
    minimizeStyle,
    suspendedInTray,
  }: {
    deckLayout: DeckLayout;
    minimizeStyle: MinimizeStyle;
    suspendedInTray: boolean;
  }) {
    // Fresh per mount (a bare call would rebuild it on every render).
    const [store] = useState(createDeckStore);
    deck = useDeck(store);
    useMinimizeMode(
      deckLayout,
      minimizeStyle,
      suspendedInTray,
      deck,
    );
    return null;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (
    minimizeStyle: MinimizeStyle,
    deckLayout: DeckLayout = "grid",
    suspendedInTray = false,
  ) =>
    act(() =>
      root.render(
        <Harness
          deckLayout={deckLayout}
          minimizeStyle={minimizeStyle}
          suspendedInTray={suspendedInTray}
        />,
      ),
    );

  it("forgets every minimized pane when None is selected and does not restore them later", () => {
    render("tray");
    const minimized: DeckState = {
      workspaces: [],
      activeId: "",
      journal: emptyJournal,
      viewByWs: {
        a: { select: "a-1", minimized: ["a-2"] },
        b: { minimized: ["b-1"] },
      },
    };
    act(() => deck.hydrate(minimized));
    expect(deck.viewByWs.a.minimized).toEqual(["a-2"]);

    render("none");
    expect(deck.viewByWs).toEqual({ a: { select: "a-1" } });

    render("tray");
    expect(deck.viewByWs).toEqual({ a: { select: "a-1" } });
  });

  it("clears minimized state that arrives while None is already active", () => {
    render("none");
    act(() =>
      deck.hydrate({
        workspaces: [],
        activeId: "",
        journal: emptyJournal,
        viewByWs: { a: { minimized: ["a-1"] } },
      }),
    );

    expect(deck.viewByWs).toEqual({});
  });

  it("keeps minimized state while only the deck layout changes to List", () => {
    render("tray");
    act(() =>
      deck.hydrate({
        workspaces: [],
        activeId: "",
        journal: emptyJournal,
        viewByWs: { a: { minimized: ["a-1"] } },
      }),
    );

    render("tray", "list");
    expect(deck.viewByWs.a.minimized).toEqual(["a-1"]);

    render("tray");
    expect(deck.viewByWs.a.minimized).toEqual(["a-1"]);
  });

  it("keeps suspended tray entries when the ordinary minimize style is None", () => {
    render("none", "grid", true);
    act(() =>
      deck.hydrate({
        workspaces: [
          {
            id: "a",
            instance: createWorkspaceInstance(),
            name: "a",
            cwd: "/tmp",
            worktreeBaseDir: null,
            panes: [
              {
                id: "a-1",
                idle: {
                  reason: "suspended",
                  at: "2026-07-25T10:00:00.000Z",
                },
              },
              { id: "a-2" },
            ],
          },
        ],
        activeId: "a",
        journal: emptyJournal,
        viewByWs: {
          a: { minimized: ["a-1", "a-2"] },
        },
      }),
    );

    expect(deck.viewByWs).toEqual({
      a: { minimized: ["a-1"] },
    });

    render("none");
    expect(deck.viewByWs).toEqual({});
  });
});
