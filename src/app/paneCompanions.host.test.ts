// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { repliedTo, useHost } from "../testing/host/host";
import { startDeck, type Deck } from "../testing/host/deck";

/**
 * A companion in a pane's process, end to end on the app itself: its hello
 * takes over the turns the pane's conversation file records — read no more,
 * while the file's numbers still are — and only a hello from the pane's own
 * process counts. A wake it declines is heard only from there too.
 */
describe("a companion in a pane's process, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async () => (deck = await startDeck(host()));
  /** An agent up, and its conversation file followed: what its CLI writes
   * there from now on is read as it is written. A record written before is
   * read as the file already was — it may end a turn, never start one. */
  async function agentFollowed(d: Deck) {
    const { paneId } = await d.agentUp();
    const about = `"paneId":"${paneId}"`;
    await host().until("its file is followed", () => repliedTo(host(), "usage_watch_session_file").some((args) => JSON.stringify(args).includes(about)), 15_000);
    return paneId;
  }
  const activity = (d: Deck, paneId: string) => d.runtime.statusTracker.getSnapshot().panes.get(paneId)?.state;
  const usedPct = (d: Deck, paneId: string) => d.runtime.usageManager.getSnapshot().panes.get(paneId)?.context?.usedPct;
  const hello = { type: "companion.hello" };
  const turn = (event: string) => ({ type: "status", event, at: new Date().toISOString() });

  /** Write one record to the pane's conversation file, as its CLI would. */
  async function record(d: Deck, paneId: string, line: Record<string, unknown>) {
    const written = () => (d.output(paneId).match(/stub: recorded /g) ?? []).length;
    const before = written();
    d.type(paneId, `record ${JSON.stringify(line)}`);
    await host().until("the record is written", () => written() > before);
  }

  /** The file's turns move the pane, as they do with no companion. */
  async function turnsRead(d: Deck, paneId: string) {
    await record(d, paneId, turn("turn-start"));
    await host().until("its turn runs", () => activity(d, paneId) === "working", 15_000);
    await record(d, paneId, turn("turn-end"));
    await host().until("its turn is over", () => activity(d, paneId) === "done", 15_000);
  }

  /** How many times the page's log has said `line`. */
  const logged = (line: string) => host().tape.filter((said) => said.way === "page log" && said.line.includes(line)).length;

  /** A turn recorded now is passed over: the numbers written after it are
   * read, and the pane stays as it was. The numbers come from the same file
   * after the turn's record, so once they are read the record is read too.
   * The control is a second read: numbers written after those, in a drain
   * of their own — once the page has them, it has handled every event of
   * the turn's drain before. */
  async function turnsPassedOver(d: Deck, paneId: string, pct: number) {
    const before = activity(d, paneId);
    await record(d, paneId, turn("turn-start"));
    await record(d, paneId, { type: "usage", usedPct: pct });
    await host().until("the numbers after it are read", () => usedPct(d, paneId) === pct, 15_000);
    await record(d, paneId, { type: "usage", usedPct: pct + 1 });
    await host().until("the next numbers are read", () => usedPct(d, paneId) === pct + 1, 15_000);
    expect(activity(d, paneId)).toBe(before);
  }

  describe("a hello", () => {
    it("from the pane's own process takes the file's turns over, and its numbers are still read", async () => {
      const d = await open();
      const paneId = await agentFollowed(d);
      await turnsRead(d, paneId);
      expect(await d.report(paneId, hello)).toBe(204);
      await turnsPassedOver(d, paneId, 37);
    });

    it("that names no process, after its own, leaves the companion it has", async () => {
      // A hello nobody can place says nothing of the process the pane is
      // pinned to: taken, it would unset the companion that process has.
      const d = await open();
      const paneId = await agentFollowed(d);
      expect(await d.report(paneId, hello)).toBe(204);
      // Admitted — no process named is no other process — and dropped by
      // the lane itself, for naming none.
      expect(await d.report(paneId, hello, "unnamed")).toBe(204);
      await host().until("the lane drops it", () => logged(`companion hello for ${paneId} names no process — ignored`) === 1);
      await turnsPassedOver(d, paneId, 41);
    });

    it("is not taken when it names no process, carries another secret, or comes from another process or agent", async () => {
      const d = await open();
      const paneId = await agentFollowed(d);
      const refused = (from: string) => logged(`companion hello for ${paneId} from ${from} — ignored`);
      // Each refused where it is refused: another secret, or a process
      // outside the pane's terminal, by the bridge's door; naming no process
      // by the lane; another process in the pane's terminal, another agent
      // by the pane's attribution.
      expect(await d.report(paneId, { ...hello, token: "stolen" })).toBe(403);
      expect(await d.report(paneId, hello, "outside")).toBe(403);
      expect(await d.report(paneId, hello, "unnamed")).toBe(204);
      await host().until("dropped for naming no process", () => logged(`companion hello for ${paneId} names no process — ignored`) === 1);
      expect(await d.report(paneId, hello, "child")).toBe(204);
      await host().until("refused for its process", () => refused("stub") === 1);
      expect(await d.report(paneId, { ...hello, payload: { agent: "codex" } })).toBe(204);
      await host().until("refused for its agent", () => refused("codex") === 1);
      // The file still says the pane's turns.
      await turnsRead(d, paneId);
    });
  });

  describe("a declined wake", () => {
    const declined = (reason: string) => ({ type: "companion.declined", payload: { reason, draft: false } });
    const heard = (reason: string) => host().tape.some(({ way, line }) => way === "page log" && line.includes(`started no turn for its doorbell (${reason})`));

    it("is heard from the pane's own process", async () => {
      const d = await open();
      const paneId = await agentFollowed(d);
      expect(await d.report(paneId, declined("the session was stopped"))).toBe(204);
      await host().until("mail hears why", () => heard("the session was stopped"));
    });

    it("is not heard with another secret, from another process or agent, or for another pane", async () => {
      const d = await open();
      const paneId = await agentFollowed(d);
      await d.report(paneId, { ...declined("a stolen secret"), token: "stolen" });
      await d.report(paneId, declined("a child's"), "child");
      await d.report(paneId, { type: "companion.declined", payload: { reason: "another agent's", draft: false, agent: "codex" } });
      await d.report(paneId, { ...declined("another pane's"), paneId: "pane-999" });
      // Its own, after them, is heard: the others were not.
      expect(await d.report(paneId, declined("its own"))).toBe(204);
      await host().until("mail hears its own", () => heard("its own"));
      for (const reason of ["a stolen secret", "a child's", "another agent's", "another pane's"]) expect(heard(reason), reason).toBe(false);
    });
  });
});
