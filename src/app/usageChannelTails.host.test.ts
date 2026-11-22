// @vitest-environment happy-dom
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callsOf, useHost } from "../testing/host/host";
import { quitAfter, startDeck, type Deck } from "../testing/host/deck";
import type { StubAgentControl } from "../testing/host/stubPlugin";
import { field, followed, lanesOf, linked, narrowings, tailsOf, unwatches } from "../testing/host/tails";

/**
 * How the page follows a pane's conversation file through the app's native
 * tailer, end to end: across a suspend and a resume, against its plugin's
 * own search, as a companion in the pane's process takes the turns' records
 * over, from where the ledger left off, and into the other stores its
 * records name.
 */
describe("following a pane's file, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async (told: Partial<StubAgentControl> = {}) => (deck = await startDeck(host(), told));
  const until = (label: string, ok: () => boolean, ms = 15_000) => host().until(label, ok, ms);
  const aWhile = () => new Promise((resolve) => setTimeout(resolve, 500));
  const mark = () => host().tape.length;
  const hello = { type: "companion.hello" };
  /** An agent up, its file followed. */
  const followedUp = async (d: Deck) => {
    const up = await d.agentUp();
    await until("its file is followed", () => followed(host(), up.paneId));
    return up;
  };
  /** A file of the stub's store, as the CLI keeps it: a line per record. */
  const storeFile = (d: Deck, name: string, ...records: Record<string, unknown>[]) => {
    mkdirSync(d.stub.storeDir, { recursive: true });
    const path = join(d.stub.storeDir, name);
    writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
    return path;
  };
  /** An agent that has said nothing yet, its process running. */
  const silent = async (d: Deck) => {
    await d.workspaceUp();
    const paneId = await d.addAgent({ role: "lead" });
    await until("its process runs", () => d.slot(paneId) === "live");
    return paneId;
  };
  /** Suspend the agent, and wait until the page reads the suspend over — a
   * resume before then hears «busy» — its file let go of. */
  const suspended = async (d: Deck, ws: { id: string }, paneId: string) => {
    const from = mark();
    expect(await d.runtime.orchestrator.suspend(ws.id, paneId)).toEqual({ kind: "suspending" });
    await until("suspended, its slot empty", () => d.phase(paneId) === "suspended" && d.settled() && d.slot(paneId) === "none");
    expect(unwatches(host(), paneId, from)).toBeGreaterThan(0);
  };
  /** Its agent binds a conversation of its own, naming `path` its file. */
  const bind = (d: Deck, paneId: string, sessionId: string, path: string) => d.report(paneId, { type: "session.bound", payload: { sessionId, transcriptPath: path } });

  describe("across a suspend", () => {
    it("lets go of a suspended pane's file, and follows it again on resume under its new process's secret", async () => {
      const d = await open();
      const { ws, paneId } = await followedUp(d);
      const before = field(tailsOf(host(), paneId)[0], "token");
      await suspended(d, ws, paneId);
      const resumed = mark();
      await d.runtime.orchestrator.resume(ws.id, paneId);
      await until("its file is followed again", () => tailsOf(host(), paneId, resumed).length > 0);
      expect(field(tailsOf(host(), paneId, resumed)[0], "token")).not.toBe(before);
    });

    it("follows a rising pane's file already, under the secret its new process reports with", async () => {
      const d = await open();
      const { ws, paneId } = await followedUp(d);
      const before = field(tailsOf(host(), paneId)[0], "token");
      await suspended(d, ws, paneId);
      // The resume's plan, and its secret, stand before its process opens.
      const rising = host().hold({ request: "pty_open" });
      const resumed = mark();
      const resuming = d.runtime.orchestrator.resume(ws.id, paneId);
      await rising.caught;
      await until("followed while it rises", () => tailsOf(host(), paneId, resumed).length > 0);
      const risingToken = field(tailsOf(host(), paneId, resumed)[0], "token");
      expect(risingToken).not.toBe(before);
      rising.release();
      await resuming;
      await d.upAndBound(paneId);
      // Its process, up and bound, reports under that same secret: what the
      // tail read while it rose is believed.
      d.type(paneId, 'record {"type":"usage","usedPct":55}');
      await until("its record is read", () => d.runtime.usageManager.getSnapshot().panes.get(paneId)?.context?.usedPct === 55);
      expect(new Set(tailsOf(host(), paneId, resumed).map((tail) => field(tail, "token")))).toEqual(new Set([risingToken]));
    });
  });

  describe("across a restart", () => {
    it("follows the file under the new process's secret after a restart, and believes it though the process names no file", async () => {
      const d = await open();
      const { ws, paneId } = await followedUp(d);
      const before = field(tailsOf(host(), paneId)[0], "token");
      // The new process says nothing at start: no binding names its file —
      // as a CLI whose start hook was missed. It writes the same file.
      d.stub.unbound = true;
      const opening = host().hold({ request: "pty_open" });
      const restarted = mark();
      expect((await d.runtime.orchestrator.restart(ws.id, paneId, "resume")).kind).toBe("accepted");
      await opening.caught;
      // Its new plan stands: the file is followed under that plan's secret,
      // before the process even opens.
      await until("followed under the new secret", () => tailsOf(host(), paneId, restarted).some((tail) => field(tail, "token") !== before));
      expect(unwatches(host(), paneId, restarted)).toBeGreaterThan(0);
      opening.release();
      await until("its new process runs", () => d.launches(paneId).length === 2 && d.slot(paneId) === "live");
      d.type(paneId, 'record {"type":"usage","usedPct":66}');
      await until("its record is believed", () => d.runtime.usageManager.getSnapshot().panes.get(paneId)?.context?.usedPct === 66);
    });
  });

  describe("against its plugin's own search", () => {
    it("leaves a binding's follow alone when a search racing it finds nothing", async () => {
      const { paneId } = await quitAfter(host(), (d) => d.agentUp(), (onDisk, up) => onDisk.includes(up.session));
      let finish = () => {};
      // The deck it boots from asks the plugin to find the conversation it
      // holds; the search is still out when the resumed process binds.
      deck = await startDeck(host(), { lookupMisses: true, lookupHeld: new Promise<void>((resolve) => (finish = resolve)) });
      const d = deck;
      await until("its plugin searches", () => d.stub.lookups > 0);
      await until("the binding's file is followed", () => tailsOf(host(), paneId, host().launchedAt()).length > 0);
      const answered = mark();
      finish();
      await aWhile();
      expect(unwatches(host(), paneId, answered)).toBe(0);
    });
  });

  describe("against a secret that changes during a search", () => {
    it("follows a file a search found under the secret that stands when it answers", async () => {
      const { paneId } = await quitAfter(host(), (d) => d.agentUp(), (onDisk, up) => onDisk.includes(up.session));
      let finish = () => {};
      // Its resumed process says nothing: only the search can follow it.
      // The search is out while the pane is restarted under a new plan.
      deck = await startDeck(host(), { unbound: true, lookupHeld: new Promise<void>((resolve) => (finish = resolve)) });
      const d = deck;
      await until("its plugin searches", () => d.stub.lookups > 0);
      await until("its process runs", () => d.slot(paneId) === "live");
      expect((await d.runtime.orchestrator.restart(d.workspace().id, paneId, "resume")).kind).toBe("accepted");
      // This launch's second process: the boot's resume, then the restart's.
      const opened = () => callsOf(host(), "pty_open", host().launchedAt()).filter((args) => JSON.stringify(field(args, "owner")).includes(`"${paneId}"`)).length;
      await until("its new process runs", () => opened() === 2 && d.slot(paneId) === "live");
      finish();
      await until("the found file is followed", () => tailsOf(host(), paneId, host().launchedAt()).length > 0);
      d.type(paneId, 'record {"type":"usage","usedPct":44}');
      await until("its record is believed", () => d.runtime.usageManager.getSnapshot().panes.get(paneId)?.context?.usedPct === 44);
    });
  });

  describe("with a companion in the pane's process", () => {
    it("narrows a followed file to its numbers once the pinned process says hello, reading nothing again", async () => {
      const d = await open();
      const { paneId } = await followedUp(d);
      expect(lanesOf(tailsOf(host(), paneId)[0])).toEqual(["usage", "status"]);
      const said = mark();
      expect(await d.report(paneId, hello)).toBe(204);
      await until("it is narrowed", () => narrowings(host(), paneId, said).length > 0);
      expect(narrowings(host(), paneId, said)).toEqual([[expect.objectContaining({ lane: "usage" })]]);
      expect(tailsOf(host(), paneId, said)).toEqual([]);
      expect(unwatches(host(), paneId, said)).toBe(0);
      // The same hello again changes nothing.
      expect(await d.report(paneId, hello)).toBe(204);
      await aWhile();
      expect(narrowings(host(), paneId, said)).toHaveLength(1);
    });

    it("narrows a follow still reading the file once it lands, following nothing again", async () => {
      const d = await open();
      const landing = host().hold({ reply: "usage_watch_session_file" });
      const { paneId } = await d.agentUp();
      await landing.caught;
      const said = mark();
      expect(await d.report(paneId, hello)).toBe(204);
      await aWhile();
      expect(narrowings(host(), paneId, said)).toEqual([]);
      landing.release();
      await until("it is narrowed", () => narrowings(host(), paneId, said).length > 0);
      expect(tailsOf(host(), paneId)).toHaveLength(1);
      expect(unwatches(host(), paneId, said)).toBe(0);
    });

    it("follows the file afresh when the app cannot narrow it where it stands", async () => {
      // Its turns' records carry its calls: narrowing would change what is
      // booked, which the native side refuses to do in place.
      const d = await open({ statusWatchesCalls: true });
      const { paneId } = await followedUp(d);
      const said = mark();
      expect(await d.report(paneId, hello)).toBe(204);
      await until("it is followed afresh", () => tailsOf(host(), paneId, said).length > 0);
      expect(unwatches(host(), paneId, said)).toBeGreaterThan(0);
      expect(lanesOf(tailsOf(host(), paneId, said)[0])).toEqual(["usage"]);
    });

    it("follows only the numbers from the start for a process that said hello before its binding", async () => {
      const d = await open({ unbound: true });
      const paneId = await silent(d);
      expect(await d.report(paneId, hello)).toBe(204);
      expect(await bind(d, paneId, "s-own", storeFile(d, "s-own.jsonl"))).toBe(204);
      await until("its file is followed", () => followed(host(), paneId));
      expect(tailsOf(host(), paneId).map(lanesOf)).toEqual([["usage"]]);
    });

    it("reads everything for a hello from another process than the one the pane is pinned to", async () => {
      const d = await open();
      const { paneId } = await followedUp(d);
      const said = mark();
      expect(await d.report(paneId, hello, "child")).toBe(204);
      await aWhile();
      expect(narrowings(host(), paneId, said)).toEqual([]);
      expect(tailsOf(host(), paneId, said)).toEqual([]);
    });

    it("reads everything again once the conversation moves into a process that never said hello", async () => {
      const d = await open();
      const { paneId } = await followedUp(d);
      expect(await d.report(paneId, hello)).toBe(204);
      await until("it is narrowed", () => narrowings(host(), paneId).length > 0);
      // Its agent re-hosts the conversation in a process it started: the
      // pane is pinned to that one now, which said nothing.
      const moved = mark();
      const file = storeFile(d, "s-moved.jsonl");
      expect(await d.report(paneId, { type: "session.bound", payload: { sessionId: "s-moved", source: "fork", transcriptPath: file } }, "child")).toBe(204);
      await until("the moved conversation's file is followed", () => tailsOf(host(), paneId, moved).some((tail) => field(tail, "path") === file));
      expect(lanesOf(tailsOf(host(), paneId, moved).find((tail) => field(tail, "path") === file))).toEqual(["usage", "status"]);
    });

    it("reads everything for a hello in an agent whose plugin declares no cover", async () => {
      const d = await open({ covers: false });
      const { paneId } = await followedUp(d);
      const said = mark();
      expect(await d.report(paneId, hello)).toBe(204);
      await aWhile();
      expect(narrowings(host(), paneId, said)).toEqual([]);
      expect(tailsOf(host(), paneId, said)).toEqual([]);
      expect(lanesOf(tailsOf(host(), paneId)[0])).toEqual(["usage", "status"]);
    });

    it("reads the file for its turns again after a restart, under the new process's secret, until that one says hello", async () => {
      const d = await open();
      const { ws, paneId } = await followedUp(d);
      const before = field(tailsOf(host(), paneId)[0], "token");
      expect(await d.report(paneId, hello)).toBe(204);
      await until("it is narrowed", () => narrowings(host(), paneId).length > 0);
      // The companion left with its process; the new one has said nothing.
      const rising = host().hold({ request: "pty_open" });
      const restarted = mark();
      expect((await d.runtime.orchestrator.restart(ws.id, paneId, "resume")).kind).toBe("accepted");
      await rising.caught;
      await until("the file is followed again", () => tailsOf(host(), paneId, restarted).length > 0);
      const again = tailsOf(host(), paneId, restarted)[0];
      expect(lanesOf(again)).toEqual(["usage", "status"]);
      expect(field(again, "token")).not.toBe(before);
      rising.release();
    });
  });

  describe("from where the ledger left off", () => {
    /** The app's answer to the page's first `cmd` from `from` on. */
    const answerTo = (cmd: string, from: number): unknown => {
      const asked = host()
        .tape.slice(from)
        .find(({ way, line }) => way === "page →" && line.includes(`"cmd":"${cmd}"`));
      const id = asked ? field(JSON.parse(asked.line), "id") : undefined;
      const reply = host().tape.find(({ way, line }) => way === "← host" && line.startsWith(`{"id":${String(id)},`));
      return reply ? field(JSON.parse(reply.line), "ok") : undefined;
    };

    it("reads the file again only from where the ledger has not booked its conversation", async () => {
      const d = await open();
      const from = mark();
      const { paneId, session } = await followedUp(d);
      const since = answerTo("usage_since", from);
      expect(typeof since).toBe("number");
      expect(tailsOf(host(), paneId)[0]).toMatchObject({ session, since });
    });

    it("reads the whole file when the ledger cannot say: it books each call once anyway", async () => {
      const d = await open();
      host().fail("usage_since");
      const { paneId } = await followedUp(d);
      expect(tailsOf(host(), paneId)).toEqual([expect.objectContaining({ since: null })]);
    });
  });

  describe("into the stores its records name", () => {
    it("links each named store once, where its plugin finds it", async () => {
      const d = await open();
      const { paneId } = await followedUp(d);
      const [two, three] = [storeFile(d, "t-2.jsonl"), storeFile(d, "t-3.jsonl")];
      d.type(paneId, 'record {"type":"usage","links":["t-2","t-3"]}');
      await until("both are linked", () => linked(host(), paneId).length === 2);
      // Named again: nothing more.
      const lookups = d.stub.lookups;
      d.type(paneId, 'record {"type":"usage","links":["t-2"],"usedPct":77}');
      await until("that record is read", () => d.runtime.usageManager.getSnapshot().panes.get(paneId)?.context?.usedPct === 77);
      await aWhile();
      expect(linked(host(), paneId)).toEqual([two, three]);
      expect(d.stub.lookups).toBe(lookups);
    });

    it("links a store named while the follow still reads the file once it is there", async () => {
      const d = await open({ unbound: true });
      const paneId = await silent(d);
      const two = storeFile(d, "t-2.jsonl");
      const own = storeFile(d, "s-own.jsonl", { type: "usage", links: ["t-2"] });
      const landing = host().hold({ reply: "usage_watch_session_file" });
      expect(await bind(d, paneId, "s-own", own)).toBe(204);
      await landing.caught;
      await aWhile();
      expect(linked(host(), paneId)).toEqual([]);
      landing.release();
      await until("it is linked", () => linked(host(), paneId).length > 0);
      expect(linked(host(), paneId)).toEqual([two]);
    });

    it("tries a named store again when its plugin could not find it", async () => {
      const d = await open();
      const { paneId } = await followedUp(d);
      await aWhile();
      const lookups = d.stub.lookups;
      d.type(paneId, 'record {"type":"usage","links":["t-9"]}');
      await until("its plugin looked for it", () => d.stub.lookups > lookups);
      await aWhile();
      expect(linked(host(), paneId)).toEqual([]);
      const nine = storeFile(d, "t-9.jsonl");
      d.type(paneId, 'record {"type":"usage","links":["t-9"]}');
      await until("it is linked", () => linked(host(), paneId).length > 0);
      expect(linked(host(), paneId)).toEqual([nine]);
    });

    it("links nothing a report names for a pane whose file it does not follow", async () => {
      // Its plugin declares a tail; this pane named no file, and its search
      // finds none.
      const d = await open({ keepsStore: false, lookupMisses: true });
      const { paneId } = await d.agentUp();
      await until("its plugin searched", () => d.stub.lookups > 0);
      await aWhile();
      expect(tailsOf(host(), paneId)).toEqual([]);
      const lookups = d.stub.lookups;
      storeFile(d, "t-2.jsonl");
      expect(await d.report(paneId, { type: "usage.report", payload: { links: ["t-2"] } })).toBe(204);
      await aWhile();
      expect(d.stub.lookups).toBe(lookups);
      expect(callsOf(host(), "usage_link_session_file")).toEqual([]);
    });
  });
});
