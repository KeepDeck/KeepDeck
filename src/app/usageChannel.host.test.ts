// @vitest-environment happy-dom
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LimitsRead } from "@keepdeck/plugin-api";
import { callsOf, useHost } from "../testing/host/host";
import { quitAfter, startDeck, type Deck } from "../testing/host/deck";
import { STUB_PLUGIN_ID, type StubAgentControl } from "../testing/host/stubPlugin";
import * as tails from "../testing/host/tails";
import { field } from "../testing/host/tails";
import { TAIL_RETRY_MS } from "./usageChannelTails";

/**
 * What the page's usage channel makes of an agent's numbers, end to end on
 * the app itself: its reports through the bridge, the records of its
 * conversation's file the native tailer follows, the account's limits its
 * plugin reads, and the stores its plugin names to read cold at boot.
 */
describe("the usage channel, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async (told: Partial<StubAgentControl> = {}) => (deck = await startDeck(host(), told));
  const until = (label: string, ok: () => boolean, ms = 15_000) => host().until(label, ok, ms);
  const aWhile = () => new Promise((resolve) => setTimeout(resolve, 500));
  const usage = (payload: Record<string, unknown>) => ({ type: "usage.report", payload });
  const paneUsage = (d: Deck, paneId: string) => d.runtime.usageManager.getSnapshot().panes.get(paneId);
  const account = (d: Deck) => d.runtime.usageManager.getSnapshot().accounts.get("stub");
  const tailsOf = (paneId: string, mark = 0) => tails.tailsOf(host(), paneId, mark);
  const unwatches = (paneId: string, mark = 0) => tails.unwatches(host(), paneId, mark);
  const followed = (paneId: string) => tails.followed(host(), paneId);
  /** An agent up, its file followed. */
  const followedUp = async (d: Deck) => {
    const up = await d.agentUp();
    await until("its file is followed", () => followed(up.paneId));
    return up;
  };
  /** A file of the stub's store, as the CLI keeps it: a line per record. */
  const storeFile = (d: Deck, name: string, ...records: Record<string, unknown>[]) => {
    mkdirSync(d.stub.storeDir, { recursive: true });
    const path = join(d.stub.storeDir, name);
    writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
    return path;
  };

  describe("a pane's reports", () => {
    it("applies a verified report's account claim, booked to the pane that made it", async () => {
      const d = await open();
      const { paneId } = await d.agentUp();
      expect(await d.report(paneId, usage({ limits: { usedPct: 30 } }))).toBe(204);
      expect(account(d)).toMatchObject({ kind: "reported", sourcePaneId: paneId, windows: [expect.objectContaining({ usedPct: 30 })] });
    });

    it("carries a record of the pane's file into its numbers", async () => {
      const d = await open();
      const { paneId } = await followedUp(d);
      d.type(paneId, 'record {"type":"usage","usedPct":10}');
      await until("the record is read", () => paneUsage(d, paneId)?.context?.usedPct === 10);
    });

    it("books a followed file's calls under the conversation its tail follows, not the one the pane moved to", async () => {
      const d = await open();
      const { paneId, session } = await followedUp(d);
      // The agent moves to another conversation, naming no file of it.
      expect(await d.report(paneId, { type: "session.bound", payload: { sessionId: "s-moved", source: "clear" } })).toBe(204);
      await until("the pane moved", () => d.pane(paneId).session?.id === "s-moved");
      const mark = host().tape.length;
      d.type(paneId, 'record {"type":"usage","calls":["call-1"]}');
      await until("its calls are booked", () => callsOf(host(), "usage_book_calls", mark).length > 0);
      expect(callsOf(host(), "usage_book_calls", mark)).toEqual([
        { entry: expect.objectContaining({ batch: expect.objectContaining({ agent: "stub", sessionId: session, calls: [expect.objectContaining({ id: "call-1" })] }) }) },
      ]);
    });

    it("lets a pane's numbers go when the pane leaves the deck, and keeps the account's", async () => {
      const d = await open();
      const { paneId } = await d.agentUp();
      expect(await d.report(paneId, usage({ usedPct: 20, limits: { usedPct: 30 } }))).toBe(204);
      expect(paneUsage(d, paneId)).toBeDefined();
      await d.closeAgent(paneId);
      expect(paneUsage(d, paneId)).toBeUndefined();
      expect(account(d)).toMatchObject({ windows: [expect.objectContaining({ usedPct: 30 })] });
    });
  });

  describe("following a pane's file", () => {
    it("follows the file a binding names, read for exactly what its plugin declares", async () => {
      const d = await open();
      const { paneId, session } = await followedUp(d);
      // No secret: the tail is the deck's own reader of the file, and what it
      // reads crosses no door.
      expect(tailsOf(paneId)).toContainEqual({
        path: join(d.stub.storeDir, `${session}.jsonl`),
        agent: "stub",
        session,
        // Its numbers' records, then its turns': the usage watch first.
        watches: [expect.objectContaining({ lane: "usage" }), expect.objectContaining({ lane: "status" })],
        siblings: null,
        since: expect.anything(),
      });
    });

    it("follows nothing for an agent whose plugin declares no tail", async () => {
      const d = await open({ tailed: false });
      const { paneId } = await d.agentUp();
      await aWhile();
      expect(tailsOf(paneId)).toEqual([]);
    });

    it("follows nothing a binding under a forged secret names", async () => {
      const d = await open();
      const { paneId } = await followedUp(d);
      const mark = host().tape.length;
      // Swaps to another conversation: the secret alone decides. The forged
      // one names a conversation and a file of its own, and is refused at
      // the bridge's door.
      const swap = (sessionId: string) => ({ type: "session.bound", payload: { sessionId, source: "clear", transcriptPath: storeFile(d, `${sessionId}.jsonl`) } });
      expect(await d.report(paneId, { ...swap("s-forged"), token: "forged" })).toBe(403);
      // The same, under the pane's own secret, is followed — and by then the
      // forged one would have been too.
      const control = swap("s-control");
      expect(await d.report(paneId, control)).toBe(204);
      await until("the control's file is followed", () => tailsOf(paneId, mark).some((tail) => field(tail, "path") === control.payload.transcriptPath));
      expect(tailsOf(paneId, mark).map((tail) => field(tail, "session"))).toEqual(["s-control"]);
    });

    it("follows nothing for a binding that names no file, when its plugin's search finds none", async () => {
      const d = await open({ keepsStore: false });
      const { paneId } = await d.agentUp();
      await until("its plugin searched", () => d.stub.lookups > 0);
      await aWhile();
      expect(tailsOf(paneId)).toEqual([]);
    });

    it("lets go of the file when its pane leaves the deck", async () => {
      const d = await open();
      const { paneId } = await followedUp(d);
      const mark = host().tape.length;
      await d.closeAgent(paneId);
      await until("its file is let go", () => unwatches(paneId, mark) > 0);
    });

    it("lets go of a file whose follow lands after its pane left", async () => {
      const d = await open();
      const landing = host().hold({ reply: "usage_watch_session_file" });
      const { paneId } = await d.agentUp();
      await landing.caught;
      await d.closeAgent(paneId);
      const mark = host().tape.length;
      landing.release();
      await until("the late follow is undone", () => unwatches(paneId, mark) > 0);
    });
  });

  describe("a conversation its plugin finds", () => {
    /** An agent bound to a conversation whose file it named nowhere — as a
     * CLI resumed in its own terminal does — and that file, kept after its
     * plugin first looked and found nothing. */
    const unfound = async (d: Deck) => {
      const up = await d.agentUp();
      await until("its plugin searched", () => d.stub.lookups > 0);
      await aWhile();
      const searches = d.stub.lookups;
      const path = storeFile(d, `${up.session}.jsonl`);
      // Nothing changes on the deck now, so nothing searches again of itself:
      // what follows the file is what each scenario does next.
      await aWhile();
      expect(d.stub.lookups).toBe(searches);
      expect(tailsOf(up.paneId).some((tail) => field(tail, "path") === path)).toBe(false);
      return { ...up, path };
    };
    /** Whether the page has followed `path` for the pane, from `mark` on. */
    const follows = (paneId: string, path: string, mark = 0) => tailsOf(paneId, mark).some((tail) => field(tail, "path") === path);
    /** The follow came sooner than the slow timer's first tick for a page
     * started at `pageStarted`: the timer cannot be what found it. */
    const beforeTheTimer = (pageStarted: number) => expect(Date.now() - pageStarted).toBeLessThan(TAIL_RETRY_MS);

    it("follows the file its plugin finds for a conversation the deck holds and no process of this launch bound", async () => {
      // The app quits with an agent bound; at the next launch its resumed
      // process says nothing — as a CLI resumed in its own terminal does.
      const { paneId, session } = await quitAfter(host(), (d) => d.agentUp(), (onDisk, up) => onDisk.includes(up.session));
      const path = join(host().home, "stub-store", `${session}.jsonl`);
      const pageStarted = Date.now();
      deck = await startDeck(host(), { unbound: true });
      // The deck it booted from is what asks.
      await until("the found file is followed", () => follows(paneId, path, host().launchedAt()));
      beforeTheTimer(pageStarted);
      expect(tailsOf(paneId, host().launchedAt()).find((tail) => field(tail, "path") === path)).toMatchObject({ agent: "stub", session });
    });

    it("searches again when the deck's panes change", async () => {
      const pageStarted = Date.now();
      const d = await open({ keepsStore: false });
      const { paneId, path } = await unfound(d);
      const teamId = d.pane(paneId).team?.teamId;
      if (!teamId) throw new Error("the agent is on no team");
      await d.memberUp(teamId, "reviewer");
      await until("the found file is followed", () => follows(paneId, path));
      beforeTheTimer(pageStarted);
    });

    it("searches again on its slow timer while nothing changes", async () => {
      const d = await open({ keepsStore: false });
      const { paneId, path } = await unfound(d);
      const revision = d.runtime.deckStore.revision();
      await until("the found file is followed", () => follows(paneId, path), 30_000);
      // Nothing was written to the deck meanwhile, and its declarations
      // stood: the timer is what searched.
      expect(d.runtime.deckStore.revision()).toBe(revision);
    }, 45_000);

    it("follows nothing a search finds after its pane left", async () => {
      const d = await open({ keepsStore: false });
      const { paneId } = await unfound(d);
      let finish = () => {};
      d.stub.lookupHeld = new Promise<void>((resolve) => (finish = resolve));
      const searches = d.stub.lookups;
      const teamId = d.pane(paneId).team?.teamId;
      if (!teamId) throw new Error("the agent is on no team");
      await d.memberUp(teamId, "reviewer");
      await until("its plugin searches again", () => d.stub.lookups > searches);
      await d.closeAgent(paneId);
      finish();
      await aWhile();
      expect(tailsOf(paneId)).toEqual([]);
    });
  });

  describe("the account's limits", () => {
    const limits = (usedPct: number, sourceAt = Date.now()): LimitsRead => ({ body: JSON.stringify({ usedPct }), sourceAt });

    it("reads its plugin's limits once at boot, then again while the agent has a live pane", async () => {
      let reads = 0;
      const d = await open({ limitsRead: () => ((reads += 1), Promise.resolve(limits(25))) });
      await until("the boot read is in", () => account(d) !== undefined);
      await d.workspaceUp();
      await aWhile();
      expect(reads).toBe(1);
      expect(account(d)).toMatchObject({ kind: "reported", windows: [expect.objectContaining({ usedPct: 25 })] });
      await d.agentUp();
      await until("a live pane's read", () => reads === 2);
    });

    it("dates the account by when its source saw it", async () => {
      const seen = Date.now() - 60_000;
      const d = await open({ limitsRead: () => Promise.resolve(limits(25, seen)) });
      await until("the boot read is in", () => account(d) !== undefined);
      expect(account(d)).toMatchObject({ reportedAt: seen });
    });

    it("reads one at a time, the last ask kept for after, each dated by its source", async () => {
      const answers: ((read: LimitsRead) => void)[] = [];
      let active = 0;
      let most = 0;
      const read = () =>
        new Promise<LimitsRead>((resolve) => {
          active += 1;
          most = Math.max(most, active);
          answers.push((answer) => {
            active -= 1;
            resolve(answer);
          });
        });
      const d = await open({ limitsRead: read });
      await until("the boot read is out", () => answers.length === 1);
      // A live pane asks while the boot read is out: one more, after it.
      await d.agentUp();
      await aWhile();
      expect(answers).toHaveLength(1);
      const first = Date.now() - 3_000;
      answers[0]?.(limits(10, first));
      await until("the live read follows", () => answers.length === 2);
      expect(account(d)).toMatchObject({ reportedAt: first });
      // The page shown again, twice, while that read is out: one after it.
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      await aWhile();
      expect(answers).toHaveLength(2);
      const second = Date.now() - 2_000;
      answers[1]?.(limits(20, second));
      await until("the shown page's read follows", () => answers.length === 3);
      expect(account(d)).toMatchObject({ reportedAt: second });
      const third = Date.now() - 1_000;
      answers[2]?.(limits(30, third));
      await until("it is in", () => field(account(d), "reportedAt") === third);
      expect(most).toBe(1);
    });
  });

  describe("the stores read cold at boot", () => {
    /** A file of the stub's store, written before the page starts. */
    const sweptFile = (record: Record<string, unknown>) => {
      const dir = join(host().home, "stub-store");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "swept.jsonl");
      writeFileSync(path, `${JSON.stringify(record)}\n`);
      return path;
    };

    it("reads the file its plugin names at boot for the account, dated by the record's own time, once", async () => {
      const written = new Date(Date.now() - 120_000);
      const path = sweptFile({ type: "usage", limits: { usedPct: 40 }, timestamp: written.toISOString() });
      const d = await open({ sweep: [path] });
      await until("the account is read from it", () => account(d) !== undefined);
      expect(account(d)).toMatchObject({ kind: "reported", reportedAt: written.getTime(), windows: [expect.objectContaining({ usedPct: 40 })] });
      // No pane: nothing to book it to but the account.
      expect(d.runtime.usageManager.getSnapshot().panes.size).toBe(0);
      expect(callsOf(host(), "usage_read_store_cold")).toEqual([{ path, watches: [expect.objectContaining({ lane: "usage" })] }]);
      // Once a launch: its plugin coming back declares the sweep again, and
      // nothing is read again.
      await d.runtime.plugins.pluginHost.setEnabled(STUB_PLUGIN_ID, false);
      await d.runtime.plugins.pluginHost.setEnabled(STUB_PLUGIN_ID, true);
      await until("its plugin is back", () => d.runtime.plugins.pluginRegistries.agents.list().some(({ entry }) => entry.id === "stub"));
      await aWhile();
      expect(callsOf(host(), "usage_read_store_cold")).toHaveLength(1);
    });

    it("dates a record that says it is from the future by its file's age instead", async () => {
      const path = sweptFile({ type: "usage", limits: { usedPct: 40 }, timestamp: "2099-01-01T00:00:00.000Z" });
      const age = Math.floor(statSync(path).mtimeMs);
      const d = await open({ sweep: [path] });
      await until("the account is read from it", () => account(d) !== undefined);
      expect(Math.floor(Number(field(account(d), "reportedAt")))).toBe(age);
    });
  });
});
