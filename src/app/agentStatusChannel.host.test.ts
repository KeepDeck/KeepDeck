// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { useHost } from "../testing/host/host";
import { startDeck, type Deck } from "../testing/host/deck";
import { STUB_PLUGIN_ID, type StubAgentControl } from "../testing/host/stubPlugin";

/**
 * What the page's status channel tells the tracker, end to end on the app
 * itself: a pane's agent reporting through the bridge, its process coming up
 * and going, its plugin losing and finding its voice, and a person's keys
 * answering what the agent waits on.
 */
describe("the status channel, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async (told: Partial<StubAgentControl> = {}) => (deck = await startDeck(host(), told));
  const status = (event: string, more: Record<string, unknown> = {}) => ({ type: "agent.status", payload: { event, ...more } });
  const permission = status("waiting", { reason: "permission" });
  const activity = (d: Deck, paneId: string) => d.runtime.statusTracker.getSnapshot().panes.get(paneId);
  const stateOf = (d: Deck, paneId: string) => activity(d, paneId)?.state;
  const until = (label: string, ok: () => boolean) => host().until(label, ok, 15_000);
  const aWhile = () => new Promise((resolve) => setTimeout(resolve, 500));
  /** An agent up, and at its prompt as it said it was coming up. */
  const ready = async (d: Deck) => {
    const up = await d.agentUp();
    await until("it said it is ready", () => stateOf(d, up.paneId) === "ready");
    return up;
  };
  /** A second agent beside the first, on its team, at its prompt too. */
  const neighbour = async (d: Deck, first: string) => {
    const teamId = d.pane(first).team?.teamId;
    if (!teamId) throw new Error("the first agent is on no team");
    const paneId = await d.memberUp(teamId, "reviewer");
    await until("the neighbour is ready", () => stateOf(d, paneId) === "ready");
    return paneId;
  };
  const enabled = (d: Deck, on: boolean) => d.runtime.plugins.pluginHost.setEnabled(STUB_PLUGIN_ID, on);
  /** What the agent waits on, said by its hook. */
  const waitsOn = async (d: Deck, paneId: string, reason: "permission" | "question") => {
    expect(await d.report(paneId, status("waiting", { reason }))).toBe(204);
    expect(activity(d, paneId)).toMatchObject({ state: "waiting", reason });
  };

  describe("a process ending", () => {
    it("clears a pane's activity the moment its process exits", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      expect(await d.report(paneId, status("turn-start"))).toBe(204);
      expect(stateOf(d, paneId)).toBe("working");
      d.type(paneId, "exit 0");
      await until("its process exited", () => d.slot(paneId) === "exited");
      expect(activity(d, paneId)).toBeUndefined();
    });

    it("sweeps only the dead: a live neighbour keeps its activity", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      const other = await neighbour(d, paneId);
      expect(await d.report(paneId, status("turn-start"))).toBe(204);
      await waitsOn(d, other, "permission");
      d.type(paneId, "exit 0");
      await until("the first exited, its activity gone", () => d.slot(paneId) === "exited" && activity(d, paneId) === undefined);
      expect(stateOf(d, other)).toBe("waiting");
    });

    it("sweeps a spawn that failed like an exit: what its hook said while it started does not outlive it", async () => {
      // The agent's program is gone between its plan and its spawn.
      const d = await open({ programGone: true });
      await d.workspaceUp();
      const spawning = host().hold({ request: "pty_open" });
      const paneId = await d.addAgent({ role: "lead" });
      await spawning.caught;
      // A hook beats the spawn's answer: taken, the process still starting.
      expect(await d.report(paneId, permission, "outside")).toBe(204);
      expect(d.slot(paneId)).toBe("starting");
      expect(stateOf(d, paneId)).toBe("waiting");
      spawning.release();
      await until("the spawn failed", () => d.slot(paneId) === "failed");
      expect(activity(d, paneId)).toBeUndefined();
    });
  });

  describe("an agent's voice", () => {
    it("reads started for a live process of an agent with a voice, and not before it is live", async () => {
      // The agent says nothing at start: what the pane reads is the host's.
      const d = await open({ unbound: true });
      await d.workspaceUp();
      const spawned = host().hold({ reply: "pty_open" });
      const paneId = await d.addAgent({ role: "lead" });
      await spawned.caught;
      await aWhile();
      expect(d.slot(paneId)).toBe("starting");
      expect(activity(d, paneId)).toBeUndefined();
      spawned.release();
      await until("it reads started", () => stateOf(d, paneId) === "started");
    });

    it("reads nothing for an agent that declares no status: it would read Started through every turn", async () => {
      const d = await open({ voiceless: true });
      const { paneId } = await d.agentUp();
      await aWhile();
      expect(d.slot(paneId)).toBe("live");
      expect(activity(d, paneId)).toBeUndefined();
    });

    it("reads nothing for a process launched bare: it can never report a turn to end the Started", async () => {
      const d = await open({ spawnPlanFails: "the stub's plan cannot be built" });
      await d.workspaceUp();
      const paneId = await d.addAgent({ role: "lead" });
      await until("its process runs", () => d.slot(paneId) === "live");
      // Its own bin, with nothing of the plan's — no bridge to report through.
      expect(d.launches(paneId)[0]?.args).toEqual([]);
      await aWhile();
      expect(activity(d, paneId)).toBeUndefined();
    });

    it("clears the panes of an agent whose plugin goes: nothing could resolve what it last said", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      await waitsOn(d, paneId, "permission");
      await enabled(d, false);
      await until("its activity is gone", () => activity(d, paneId) === undefined);
      // Its process lives on: no sweep would ever have cleared it.
      expect(d.slot(paneId)).toBe("live");
    });

    it("reads started again for the live panes of an agent whose plugin comes back", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      await enabled(d, false);
      await until("its activity is gone", () => activity(d, paneId) === undefined);
      await enabled(d, true);
      await until("it reads started", () => stateOf(d, paneId) === "started");
    });

    it("hears an agent in the words of its plugin's new activation, and not in the old one's", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      await enabled(d, false);
      // Updated between two activations: a turn starts with another word.
      d.stub.turnStartWord = "turn-begin";
      await enabled(d, true);
      await until("it reads started", () => stateOf(d, paneId) === "started");
      expect(await d.report(paneId, status("turn-start"))).toBe(204);
      expect(stateOf(d, paneId)).toBe("started");
      expect(await d.report(paneId, status("turn-begin"))).toBe(204);
      expect(stateOf(d, paneId)).toBe("working");
    });
  });

  describe("an ask riding on a report", () => {
    it("announces a compaction before the ask it rides on is answered: what the rebuild re-states is queued by then", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      // Where on the tape the page heard the rebuild — and where it answered.
      const rebuilt: number[] = [];
      d.runtime.statusTracker.onContextRebuilt((pane) => {
        if (pane === paneId) rebuilt.push(host().tape.length);
      });
      const mark = host().tape.length;
      await d.report(paneId, status("context-compacted", { reply: "compact-1" }));
      const answered = host().tape.findIndex((said, at) => at >= mark && said.way === "page →" && said.line.includes('"cmd":"bridge_reply"'));
      expect(rebuilt).toHaveLength(1);
      expect(answered).toBeGreaterThanOrEqual(rebuilt[0] ?? Number.POSITIVE_INFINITY);
    });
  });

  describe("the deck's panes", () => {
    it("keeps the activity of only the panes the deck holds", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      const other = await neighbour(d, paneId);
      expect(await d.report(paneId, status("turn-start"))).toBe(204);
      expect(await d.report(other, status("turn-start"))).toBe(204);
      await d.closeAgent(other);
      await until("the neighbour's activity is gone with it", () => activity(d, other) === undefined);
      expect(stateOf(d, paneId)).toBe("working");
    });
  });

  describe("a person's keys", () => {
    it("resolves a wait no agent reports resolved with the person's own answer", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      await waitsOn(d, paneId, "permission");
      d.press(paneId, "\r");
      expect(stateOf(d, paneId)).toBe("working");
    });

    it("never finishes a question by a key: the agent's own word does", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      await waitsOn(d, paneId, "question");
      // Enter last: the stub reads lines, and its next cue must start one.
      for (const key of ["a", "\x1b[A", "\r"]) d.press(paneId, key);
      expect(activity(d, paneId)).toMatchObject({ state: "waiting", reason: "question" });
      expect(await d.report(paneId, status("resumed", { reason: "question" }))).toBe(204);
      expect(stateOf(d, paneId)).toBe("working");
    });

    it("answers nothing by reading the question back", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      await waitsOn(d, paneId, "permission");
      // Scrolling back to see what is asked: an arrow, a page up, Alt+Left.
      for (const key of ["\x1b[A", "\x1b[5~", "\x1bb"]) d.press(paneId, key);
      expect(stateOf(d, paneId)).toBe("waiting");
    });

    it("answers only the pane the key was pressed in", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      const other = await neighbour(d, paneId);
      await waitsOn(d, paneId, "permission");
      await waitsOn(d, other, "permission");
      d.press(other, "y");
      expect(stateOf(d, paneId)).toBe("waiting");
      expect(stateOf(d, other)).toBe("working");
    });

    it("starts nothing where nothing waits: at an agent's prompt, or in a pane the deck has no agent for", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      d.press(paneId, "l");
      d.press("shell-pane", "s");
      expect(stateOf(d, paneId)).toBe("ready");
      expect(activity(d, "shell-pane")).toBeUndefined();
    });

    it("answers nothing by a key pressed before the session is live: the write went nowhere", async () => {
      const d = await open({ unbound: true });
      await d.workspaceUp();
      const spawned = host().hold({ reply: "pty_open" });
      const paneId = await d.addAgent({ role: "lead" });
      await spawned.caught;
      // A hook beats the spawn's answer, and the pane waits while starting.
      expect(await d.report(paneId, permission, "outside")).toBe(204);
      expect(d.slot(paneId)).toBe("starting");
      d.press(paneId, "\r");
      expect(stateOf(d, paneId)).toBe("waiting");
      spawned.release();
    });
  });

  describe("the page going", () => {
    it("reads no key once it is gone", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      await waitsOn(d, paneId, "permission");
      const tracker = d.runtime.statusTracker;
      d.dispose();
      deck = null;
      d.press(paneId, "\r");
      expect(tracker.getSnapshot().panes.get(paneId)?.state).toBe("waiting");
    });

    it("sweeps nothing once it is gone", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      expect(await d.report(paneId, status("turn-start"))).toBe(204);
      const tracker = d.runtime.statusTracker;
      d.dispose();
      deck = null;
      d.type(paneId, "exit 0");
      await aWhile();
      expect(tracker.getSnapshot().panes.get(paneId)?.state).toBe("working");
    });
  });
});
