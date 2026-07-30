import { describe, expect, it } from "vitest";
import { emptyJournal } from "../domain/journal";
import type { MinimizeStyle } from "../domain/settings";
import { createDeckStore } from "./deckStore";
import { createMinimizePolicy, type MinimizeSettingsPort } from "./minimizePolicy";

function settingsHarness(initial: MinimizeStyle) {
  let style = initial;
  const listeners = new Set<() => void>();
  const port: MinimizeSettingsPort = {
    minimizeStyle: () => style,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    port,
    set(next: MinimizeStyle) {
      style = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const hydratedState = {
  workspaces: [],
  activeId: "",
  journal: emptyJournal,
  viewByWs: {
    a: {
      select: "a-1",
      minimized: ["a-2"],
      suspendedTray: ["a-3"],
    },
    b: { minimized: ["b-1"] },
  },
};

describe("createMinimizePolicy", () => {
  it("clears manual minimizes when None becomes active", () => {
    const deck = createDeckStore(hydratedState);
    const settings = settingsHarness("tray");
    const policy = createMinimizePolicy(deck, settings.port);

    settings.set("none");

    expect(deck.getSnapshot().viewByWs).toEqual({
      a: { select: "a-1", suspendedTray: ["a-3"] },
    });
    policy.dispose();
  });

  it("reconciles deck state that arrives while None is already active", () => {
    const deck = createDeckStore();
    const settings = settingsHarness("none");
    const policy = createMinimizePolicy(deck, settings.port);

    deck.dispatch({ type: "hydrate", state: hydratedState });

    expect(deck.getSnapshot().viewByWs).toEqual({
      a: { select: "a-1", suspendedTray: ["a-3"] },
    });
    policy.dispose();
  });

  it("does not clear manual minimizes for Tray or Strip", () => {
    const deck = createDeckStore(hydratedState);
    const settings = settingsHarness("tray");
    const policy = createMinimizePolicy(deck, settings.port);

    settings.set("strip");

    expect(deck.getSnapshot().viewByWs).toEqual(hydratedState.viewByWs);
    policy.dispose();
  });
});
