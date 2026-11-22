// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callsOf, useHost } from "../../testing/host/host";
import { quitAfter, startDeck, type Deck } from "../../testing/host/deck";
import type { StubAgentControl } from "../../testing/host/stubPlugin";

/**
 * A boot resume its agent rejected — its process exited at once, having
 * reported nothing — end to end on the app itself. The page asks the
 * agent's registry of live sessions what became of the conversation, and
 * acts on its answer: the conversation run elsewhere, a registry that
 * cannot say, one that says it is free, or none to ask.
 */
describe("a rejected boot resume, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  /** An agent up and its conversation on disk, then the app quit and
   * launched again: what boots it. */
  const bound = () =>
    quitAfter(
      host(),
      async (d) => {
        const { paneId, session } = await d.agentUp();
        return { paneId, session, launched: d.launches(paneId).length };
      },
      (onDisk, { session }) => onDisk.includes(session),
    );

  /** The page of the launch after, its stub told `told` before it plans. */
  async function relaunched(told: Partial<StubAgentControl>): Promise<Deck> {
    deck = await startDeck(host(), told);
    return deck;
  }

  const lastArgs = (d: Deck, paneId: string) => {
    const launches = d.launches(paneId);
    return launches[launches.length - 1]?.args ?? [];
  };
  const view = (d: Deck) => d.runtime.orchestrator.getView();
  /** The `launch`-th process of the pane exited, having reported nothing —
   * heard as the window's terminal hears an agent exit (App's
   * onAgentExited): the page is asked to recover it, and takes it. */
  async function rejected(d: Deck, paneId: string, launch: number): Promise<void> {
    await host().until(`launch ${launch} rejected`, () => d.launches(paneId).length === launch && d.slot(paneId) === "exited", 15_000);
    expect(d.runtime.orchestrator.recoverRejectedResume(d.workspace().id, paneId, 1)).toBe(true);
  }

  it("keeps the conversation and offers the choice when it runs in another process", async () => {
    const { paneId, session, launched } = await bound();
    const d = await relaunched({ rejectResumes: 1 });
    await d.runOutside(session);
    await rejected(d, paneId, launched + 1);
    await host().until("its card offers the choice", () => view(d).occupied[paneId]?.registry === "live");
    expect(d.pane(paneId).session?.id).toBe(session);
    expect(d.launches(paneId)).toHaveLength(launched + 1);
    expect(d.slot(paneId)).toBe("exited");
  });

  it("keeps the conversation just the same when the registry cannot say", async () => {
    const { paneId, session, launched } = await bound();
    const d = await relaunched({ rejectResumes: 1, liveRegistry: "fails" });
    await rejected(d, paneId, launched + 1);
    await host().until("its card offers the choice", () => view(d).occupied[paneId]?.registry === "unknown");
    expect(d.pane(paneId).session?.id).toBe(session);
    expect(d.launches(paneId)).toHaveLength(launched + 1);
  });

  it("retries the resume once, quietly and in place, when the registry says the conversation is free", async () => {
    const { paneId, session, launched } = await bound();
    const d = await relaunched({ rejectResumes: 1 });
    const epoch = view(d).epochs[paneId] ?? 0;
    await rejected(d, paneId, launched + 1);
    await host().until("resumed again, and up", () => d.launches(paneId).length === launched + 2 && d.slot(paneId) === "live", 15_000);
    expect(lastArgs(d, paneId)).toEqual(expect.arrayContaining(["--resume", session]));
    expect(view(d).specs[paneId]).toMatchObject({ resumeRetry: true });
    expect(d.pane(paneId).session?.id).toBe(session);
    expect(view(d).epochs[paneId] ?? 0).toBeGreaterThan(epoch);
  });

  it("starts fresh when the quiet retry is rejected too", async () => {
    const { paneId, session, launched } = await bound();
    const d = await relaunched({ rejectResumes: 2 });
    await rejected(d, paneId, launched + 1);
    await rejected(d, paneId, launched + 2);
    await host().until("a fresh start, up", () => d.launches(paneId).length === launched + 3 && d.slot(paneId) === "live", 15_000);
    expect(lastArgs(d, paneId)).not.toContain("--resume");
    await host().until("a new conversation bound", () => d.pane(paneId).session !== undefined && d.pane(paneId).session?.id !== session);
  });

  it("starts fresh at once when there is no registry to ask", async () => {
    // No registry is not the registry saying the conversation is free: no
    // quiet retry, a fresh start.
    const { paneId, session, launched } = await bound();
    const d = await relaunched({ rejectResumes: 1, liveRegistry: "none" });
    await rejected(d, paneId, launched + 1);
    await host().until("a fresh start, up", () => d.launches(paneId).length === launched + 2 && d.slot(paneId) === "live", 15_000);
    expect(lastArgs(d, paneId)).not.toContain("--resume");
    await host().until("a new conversation bound", () => d.pane(paneId).session !== undefined && d.pane(paneId).session?.id !== session);
  });

  it("keeps its promise off screen: the agent comes back though its workspace is no longer the one open", async () => {
    deck = await startDeck(host());
    const { paneId, session } = await deck.agentUp();
    const made = await deck.runtime.orchestrator.createWorkspace({ name: "two", cwd: host().trees, worktreeBaseDir: null });
    if (made.kind !== "accepted" || !made.minted.workspace) throw new Error(`no second workspace: ${JSON.stringify(made)}`);
    const other = made.minted.workspace;
    // The first one is the one open when the app quits — chosen once the
    // second one has landed, which opens it.
    await host().until("the second workspace is on the deck", () => deck?.runtime.deckStore.getSnapshot().workspaces.length === 2 && deck.settled());
    deck.runtime.deckStore.dispatch({ type: "selectWorkspace", id: deck.workspace().id });
    await host().until("on disk, the first open", () => {
      const saved = readFileSync(join(host().home, "deck.json"), "utf8");
      return saved.includes(session) && saved.includes(`"activeId":"${deck?.workspace().id}"`);
    });
    const launched = deck.launches(paneId).length;
    deck.dispose();
    deck = null;
    await host().relaunch("quit");

    const starting = host().hold({ request: "pty_open" });
    const d = (deck = await startDeck(host(), { rejectResumes: 1 }));
    await starting.caught;
    // The person turns to the other workspace while the resume starts.
    d.runtime.deckStore.dispatch({ type: "selectWorkspace", id: other });
    starting.release();
    await host().until("rejected", () => d.launches(paneId).length === launched + 1 && d.slot(paneId) === "exited", 15_000);
    expect(d.runtime.orchestrator.recoverRejectedResume(d.workspace().id, paneId, 1)).toBe(true);
    await host().until("back though off screen", () => d.launches(paneId).length === launched + 2 && d.slot(paneId) === "live", 15_000);
    expect(d.runtime.deckStore.getSnapshot().activeId).toBe(other);
  });

  describe("what counts as the resume having started", () => {
    /** Relaunched with an agent that reports nothing at start, its resume
     * up: what it reports is the test's to cue. */
    async function resumedQuiet(told: Partial<StubAgentControl> = {}) {
      const { paneId, session, launched } = await bound();
      const d = await relaunched({ unbound: true, ...told });
      await host().until("resumed, and up", () => d.launches(paneId).length === launched + 1 && d.slot(paneId) === "live", 15_000);
      return { d, paneId, session, launched };
    }

    it("is not another agent's binding: a resume that only heard one died without a word of its own", async () => {
      const { d, paneId, launched } = await resumedQuiet({ liveRegistry: "none" });
      // Another CLI run inside the pane reports its own conversation, which
      // the deck refuses; then the resumed agent ends.
      expect(await d.report(paneId, { type: "session.bound", payload: { sessionId: "k-1", agent: "kimi" } }, "child")).toBe(204);
      d.type(paneId, "exit 1");
      await rejected(d, paneId, launched + 1);
      await host().until("a fresh start, up", () => d.launches(paneId).length === launched + 2 && d.slot(paneId) === "live", 15_000);
    });

    it("is its own conversation bound: a resume that reported, then ended, is not taken over as rejected", async () => {
      const { d, paneId, session, launched } = await resumedQuiet();
      expect(await d.report(paneId, { type: "session.bound", payload: { sessionId: session } })).toBe(204);
      d.type(paneId, "exit 1");
      await host().until("it ended", () => d.slot(paneId) === "exited");
      expect(d.runtime.orchestrator.recoverRejectedResume(d.workspace().id, paneId, 1)).toBe(false);
      expect(d.launches(paneId)).toHaveLength(launched + 1);
    });
  });
});

describe("a plan that failed to build, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  it("is built again on Retry, and its pane starts, with no process stopped on the way", async () => {
    // A remote agent's plan has no bare local launch to fall back to: its
    // plugin's hook failing fails the whole build, and the pane waits on
    // Retry instead of quietly running here.
    const d = (deck = await startDeck(host(), { spawnPlanFails: "the plugin cannot plan it" }));
    await d.workspaceUp();
    const paneId = await d.addAgent({ role: "lead", endpoint: "ws://vps:4500" });
    const view = () => d.runtime.orchestrator.getView();
    await host().until("its plan failed", () => view().planFailed.has(paneId), 15_000);
    expect(d.launches(paneId)).toEqual([]);
    const mark = host().tape.length;
    const epoch = view().epochs[paneId] ?? 0;
    d.stub.spawnPlanFails = null;
    d.runtime.orchestrator.retryPlanBuild(paneId);
    await host().until("it starts", () => d.launches(paneId).length === 1 && d.slot(paneId) === "live", 15_000);
    expect(view().planFailed.has(paneId)).toBe(false);
    expect(view().epochs[paneId] ?? 0).toBeGreaterThan(epoch);
    expect(callsOf(host(), "pty_stop", mark)).toEqual([]);
  });
});
