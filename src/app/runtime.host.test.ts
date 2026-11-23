// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { useHost } from "../testing/host/host";
import { startDeck, type Deck } from "../testing/host/deck";
import { STUB_AGENT } from "../testing/host/stubPlugin";

/**
 * The page's whole runtime on the app itself: its doors, its machine, its
 * plans and its sessions, with the stub agent for a CLI.
 */
describe("the page on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  it("makes a workspace and an agent in it, and the agent starts and binds its conversation", async () => {
    deck = await startDeck(host());
    const { runtime } = deck;
    const made = await runtime.orchestrator.createWorkspace({ name: "ws", cwd: host().work, worktreeBaseDir: null });
    expect(made.kind).toBe("accepted");
    const ws = runtime.deckStore.getSnapshot().workspaces[0];
    if (!ws) throw new Error("no workspace on the deck");
    const added = await runtime.orchestrator.createPane({
      workspace: { id: ws.id, instance: ws.instance },
      pane: { agentType: STUB_AGENT },
      role: "lead",
    });
    expect(added.kind).toBe("accepted");
    await host().until("the agent bound its conversation", () => runtime.deckStore.getSnapshot().workspaces[0]?.panes[0]?.session !== undefined, 15_000);
  });
});
