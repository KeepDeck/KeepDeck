import { describe, expect, it } from "vitest";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { deckPresence } from "./deckPresence";

const ws = (id: string): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: `/repo/${id}`,
  worktreeBaseDir: null,
  panes: [],
});

describe("deckPresence", () => {
  it("is the welcome screen exactly when there is no workspace", () => {
    expect(deckPresence([], false).welcome).toBe(true);
    expect(deckPresence([ws("ws-1")], false).welcome).toBe(false);
  });

  it("sends New Workspace to the welcome picker with none, to the form over the deck with one", () => {
    expect(deckPresence([], false).newWorkspace).toBe("welcome");
    expect(deckPresence([ws("ws-1")], false).newWorkspace).toBe("form");
  });

  it("puts the create form on screen only when asked for and over a deck", () => {
    expect(deckPresence([ws("ws-1")], true).formOpen).toBe(true);
    expect(deckPresence([ws("ws-1")], false).formOpen).toBe(false);
    // Asked for with no workspace — the last one closed under it: the
    // welcome screen is the way in, and no form paints over it. The layering
    // reads this fact, so a form that is not there is not a modal layer.
    expect(deckPresence([], true).formOpen).toBe(false);
  });
});
