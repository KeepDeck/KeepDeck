// @vitest-environment happy-dom
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PaneSink, PaneSpawnSpec, PtyManager } from "./ptyManager";
import { callsOf, useHost } from "../testing/host/host";
import { startDeck, type Deck } from "../testing/host/deck";

/**
 * The page's session registry over the app's own sessions machine: a real
 * process in a real PTY behind every pane id, started on a lease the machine
 * grants. What the registry owes the views attached to a pane — the output
 * replayed and streamed, readiness, the launch, a death, a failed spawn —
 * and what it owes the processes: one spawn per identity, a close that
 * stops and silences, writes landing one at a time in order.
 */
describe("the page's session registry, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const aWhile = () => new Promise((resolve) => setTimeout(resolve, 500));

  /** A deck with a workspace to lease launches in, and a registry of its own. */
  async function rig() {
    const d = (deck = await startDeck(host()));
    await d.workspaceUp();
    return { d, registry: d.sessionRegistry() };
  }

  /** A view's ears: what it heard, in order, the text it was shown, and the
   * words of each failed spawn it was told of. */
  function view(opts: { throwing?: boolean } = {}) {
    const decoder = new TextDecoder();
    let text = "";
    const heard: string[] = [];
    const failures: string[] = [];
    const sink: PaneSink = {
      onOutput(bytes) {
        text += decoder.decode(bytes, { stream: true });
        heard.push("output");
        if (opts.throwing) throw new Error("the view broke");
      },
      onExit: (code, replayed) => heard.push(`exit ${String(code)}${replayed ? ", replayed" : ""}`),
      onSpawnError(message, replayed) {
        heard.push(`spawn error${replayed ? ", replayed" : ""}`);
        failures.push(message);
      },
      onReady: () => heard.push("ready"),
      onLaunched: () => heard.push("launched"),
    };
    return { sink, heard, failures, text: () => text };
  }

  /** Whether the process printed `said` as a line of its own — not the
   * terminal echoing the cue that asked for it (`say …`). The echo's line
   * end comes first, so the line printed opens with it. */
  const printed = (seen: { text(): string }, said: string) => seen.text().includes(`\n${said}\r`);

  const opens = () => callsOf(host(), "pty_open");
  const stops = () => callsOf(host(), "pty_stop");
  /** What the page wrote to the processes, each write as text, in order. */
  const written = () =>
    callsOf(host(), "pty_write").map((args) => {
      const data: unknown = typeof args === "object" && args !== null ? Reflect.get(args, "data") : undefined;
      return Array.isArray(data) && data.every((byte) => typeof byte === "number") ? new TextDecoder().decode(Uint8Array.from(data)) : "";
    });
  const logged = (line: string) => host().tape.filter((said) => said.way === "page log" && said.line.includes(line)).length;
  const stateOf = (registry: PtyManager, id: string) => registry.state(id).kind;
  const until = (label: string, ok: () => boolean) => host().until(label, ok, 15_000);
  /** Start the stub program as `id`, on a lease the machine grants now. */
  const start = async (d: Deck, registry: PtyManager, id: string, silent = false) => registry.acquire(id, d.stubProcess(silent), await d.leaseLaunch());
  const startLive = async (d: Deck, registry: PtyManager, id: string, silent = false) => {
    await start(d, registry, id, silent);
    await until(`${id} is live`, () => stateOf(registry, id) === "live");
  };
  /** Type a cue into the process's terminal. */
  const cue = (registry: PtyManager, id: string, line: string) => registry.write(id, `${line}\r`);
  /** The same program under another identity — its command another path to
   * it — as a pane moved elsewhere gets. */
  const anotherIdentity = (spec: PaneSpawnSpec): PaneSpawnSpec => ({ ...spec, command: "/usr/bin/env", args: [spec.command ?? "", ...(spec.args ?? [])] });

  describe("acquiring a pane", () => {
    it("spends the lease it was handed at the spawn door — the permit, and the owner it names", async () => {
      const { d, registry } = await rig();
      const launch = await d.leaseLaunch();
      registry.acquire("t-1", d.stubProcess(), launch);
      await until("it is live", () => stateOf(registry, "t-1") === "live");
      expect(opens()).toEqual([expect.objectContaining({ permit: launch.permit, owner: launch.owner })]);
    });

    it("spawns once for a double acquire with the same identity", async () => {
      const { d, registry } = await rig();
      const launch = await d.leaseLaunch();
      registry.acquire("t-1", d.stubProcess(), launch);
      registry.acquire("t-1", d.stubProcess(), launch);
      await until("it is live", () => stateOf(registry, "t-1") === "live");
      registry.acquire("t-1", d.stubProcess(), launch);
      await aWhile();
      expect(opens()).toHaveLength(1);
    });

    it("does not respawn an exited session on re-acquire: a restart is asked for", async () => {
      const { d, registry } = await rig();
      await startLive(d, registry, "t-1");
      cue(registry, "t-1", "exit 0");
      await until("it exited", () => stateOf(registry, "t-1") === "exited");
      await start(d, registry, "t-1");
      await aWhile();
      expect(opens()).toHaveLength(1);
      expect(stateOf(registry, "t-1")).toBe("exited");
    });

    it("respawns exactly once after a close, and the retired run reaches no view of the new one", async () => {
      const { d, registry } = await rig();
      await startLive(d, registry, "t-1");
      const first = view();
      registry.attach("t-1", first.sink);
      // The retired run's own end comes after its close: it reaches no view,
      // the one that showed it or the one shown the next run.
      const closing = registry.close("t-1");
      await start(d, registry, "t-1");
      const restarted = view();
      registry.attach("t-1", restarted.sink);
      await closing;
      await until("the new one is live", () => stateOf(registry, "t-1") === "live");
      cue(registry, "t-1", "say the second run");
      await until("the new view hears it", () => printed(restarted, "the second run"));
      expect(opens()).toHaveLength(2);
      expect([...first.heard, ...restarted.heard].filter((event) => event.startsWith("exit"))).toEqual([]);
      expect(stateOf(registry, "t-1")).toBe("live");
      expect(printed(first, "the second run")).toBe(false);
    });

    it("stops the old session and spawns again when the identity changes", async () => {
      const { d, registry } = await rig();
      await startLive(d, registry, "t-1");
      registry.acquire("t-1", anotherIdentity(d.stubProcess()), await d.leaseLaunch());
      await until("the new one is live", () => opens().length === 2 && stateOf(registry, "t-1") === "live");
      expect(stops()).toHaveLength(1);
      expect(opens()[1]).toMatchObject({ spec: expect.objectContaining({ command: "/usr/bin/env" }) });
    });
  });

  describe("attaching a view", () => {
    it("replays the output printed while no view was attached", async () => {
      const { d, registry } = await rig();
      await start(d, registry, "t-1");
      await until("it printed", () => registry.isLaunched("t-1"));
      const late = view();
      registry.attach("t-1", late.sink);
      expect(late.text()).toContain("stub: ready");
    });

    it("streams live output to the view attached", async () => {
      const { d, registry } = await rig();
      await startLive(d, registry, "t-1");
      const attached = view();
      registry.attach("t-1", attached.sink);
      cue(registry, "t-1", "say as it happens");
      await until("the view hears it", () => printed(attached, "as it happens"));
    });

    it("announces readiness when the spawn resolves, and again to a view attached late", async () => {
      const { d, registry } = await rig();
      await start(d, registry, "t-1");
      const early = view();
      registry.attach("t-1", early.sink);
      expect(early.heard).not.toContain("ready");
      await until("it is live", () => stateOf(registry, "t-1") === "live");
      expect(early.heard.filter((event) => event === "ready")).toHaveLength(1);
      const late = view();
      registry.attach("t-1", late.sink);
      expect(late.heard.filter((event) => event === "ready")).toHaveLength(1);
    });

    it("takes a view that arrives before the session, and feeds it from the first event", async () => {
      // The view mounts when the deck renders it; the process starts when the
      // orchestrator decides it should. Neither waits for the other.
      const { d, registry } = await rig();
      const first = view();
      registry.attach("t-1", first.sink);
      await start(d, registry, "t-1", true);
      await until("it is ready", () => first.heard.includes("ready"));
      cue(registry, "t-1", "say from the first event");
      await until("the view hears it", () => printed(first, "from the first event"));
      expect(first.heard.filter((event) => event === "launched")).toHaveLength(1);
    });

    it("keeps the view across a session replaced under it", async () => {
      // A restart closes the process and spawns another into the same pane;
      // its terminal is not remounted for that.
      const { d, registry } = await rig();
      await start(d, registry, "t-1");
      const kept = view();
      registry.attach("t-1", kept.sink);
      await registry.close("t-1");
      await startLive(d, registry, "t-1");
      cue(registry, "t-1", "say the replacement");
      await until("the kept view hears it", () => printed(kept, "the replacement"));
    });

    it("hands a death nobody heard to its first view as it happened, and to later views as replayed", async () => {
      const { d, registry } = await rig();
      await start(d, registry, "t-1");
      await until("it printed", () => registry.isLaunched("t-1"));
      cue(registry, "t-1", "exit 1");
      await until("it exited", () => stateOf(registry, "t-1") === "exited");
      const first = view();
      registry.attach("t-1", first.sink);
      expect(first.text()).toContain("stub: ready");
      expect(first.heard).toContain("exit 1");
      const second = view();
      registry.attach("t-1", second.sink);
      expect(second.heard).toContain("exit 1, replayed");
    });

    it("tells the death it saw apart from its re-announcements to a view mounted again", async () => {
      const { d, registry } = await rig();
      const seen = view();
      await start(d, registry, "t-1");
      registry.attach("t-1", seen.sink);
      await until("it is live", () => stateOf(registry, "t-1") === "live");
      cue(registry, "t-1", "exit 137");
      await until("the view saw it die", () => seen.heard.includes("exit 137"));
      // Mounted again over the same exited pane: the entry is reused, and
      // the death re-announced as a replay — once.
      await start(d, registry, "t-1");
      const remounted = view();
      registry.attach("t-1", remounted.sink);
      expect(remounted.heard.filter((event) => event.startsWith("exit"))).toEqual(["exit 137, replayed"]);
    });

    it("tells the views attached of a spawn that failed — as it happened once, replayed after", async () => {
      const { d, registry } = await rig();
      registry.acquire("t-1", { ...d.stubProcess(), command: join(host().work, "no-such-cli") }, await d.leaseLaunch());
      const attached = view();
      registry.attach("t-1", attached.sink);
      await until("the view is told", () => attached.heard.includes("spawn error"));
      // In the host's own words: what could not start, and why.
      expect(attached.failures).toEqual([expect.stringMatching(/no-such-cli.*ENOENT/)]);
      const late = view();
      registry.attach("t-1", late.sink);
      expect(late.heard).toContain("spawn error, replayed");
      expect(late.failures).toEqual(attached.failures);
    });

    it("hands a spawn failure nobody heard to its first view as it happened", async () => {
      const { d, registry } = await rig();
      registry.acquire("t-1", { ...d.stubProcess(), command: join(host().work, "no-such-cli") }, await d.leaseLaunch());
      await until("it failed", () => stateOf(registry, "t-1") === "failed");
      const first = view();
      registry.attach("t-1", first.sink);
      expect(first.heard).toContain("spawn error");
      expect(first.failures).toEqual([expect.stringMatching(/no-such-cli.*ENOENT/)]);
      const second = view();
      registry.attach("t-1", second.sink);
      expect(second.heard).toContain("spawn error, replayed");
      expect(second.failures).toEqual(first.failures);
    });

    it("keeps the newer view when an older one detaches after it attached — StrictMode's order", async () => {
      const { d, registry } = await rig();
      await startLive(d, registry, "t-1");
      const older = view();
      const detachOlder = registry.attach("t-1", older.sink);
      const newer = view();
      registry.attach("t-1", newer.sink);
      detachOlder();
      cue(registry, "t-1", "say after the stale detach");
      await until("the newer view hears it", () => printed(newer, "after the stale detach"));
      expect(printed(older, "after the stale detach")).toBe(false);
    });

    it("replays no more than its budget, the oldest output gone first", async () => {
      const { d, registry } = await rig();
      await startLive(d, registry, "t-1");
      // A witness attached all along says when the output is in.
      const witness = view();
      registry.attach("t-1", witness.sink);
      for (const fill of ["a", "b", "c"]) cue(registry, "t-1", `fill 600000 ${fill}`);
      cue(registry, "t-1", "say the end");
      await until("all of it printed", () => printed(witness, "the end"));
      const late = view();
      registry.attach("t-1", late.sink);
      const replay = new TextEncoder().encode(late.text()).length;
      expect(replay).toBeLessThanOrEqual(1024 * 1024);
      // What still fits is kept: more than the last fill.
      expect(replay).toBeGreaterThan(600_000);
      expect(late.text()).not.toContain("stub: ready");
      expect(printed(late, "the end")).toBe(true);
    });
  });

  describe("its startup on the log", () => {
    it("says the spawn resolved once, and only once it has", async () => {
      const { d, registry } = await rig();
      const opening = host().hold({ reply: "pty_open" });
      await start(d, registry, "t-1");
      await opening.caught;
      await aWhile();
      expect(logged("t-1: spawn resolved")).toBe(0);
      opening.release();
      await until("it resolved", () => stateOf(registry, "t-1") === "live");
      await until("the log says so", () => logged("t-1: spawn resolved") === 1);
      await aWhile();
      expect(logged("t-1: spawn resolved")).toBe(1);
    });

    it("says the first output once, not once per chunk, and never what it was", async () => {
      const { d, registry } = await rig();
      await start(d, registry, "t-1");
      await until("it printed", () => registry.isLaunched("t-1"));
      const attached = view();
      registry.attach("t-1", attached.sink);
      cue(registry, "t-1", "say more after the first");
      await until("more printed", () => printed(attached, "more after the first"));
      expect(logged("t-1: first output")).toBe(1);
      expect(logged("stub: ready")).toBe(0);
    });
  });

  describe("the launch", () => {
    it("is said on the first output only, and the pane counts as launched", async () => {
      const { d, registry } = await rig();
      const attached = view();
      await start(d, registry, "t-1", true);
      registry.attach("t-1", attached.sink);
      await until("it is live", () => stateOf(registry, "t-1") === "live");
      expect(registry.isLaunched("t-1")).toBe(false);
      cue(registry, "t-1", "say one");
      cue(registry, "t-1", "say two");
      await until("both printed", () => printed(attached, "two"));
      expect(attached.heard.filter((event) => event === "launched")).toHaveLength(1);
      expect(registry.isLaunched("t-1")).toBe(true);
    });

    it("counts the pane launched even when its view throws on the output", async () => {
      const { d, registry } = await rig();
      const broken = view({ throwing: true });
      await start(d, registry, "t-1", true);
      registry.attach("t-1", broken.sink);
      await until("it is live", () => stateOf(registry, "t-1") === "live");
      cue(registry, "t-1", "say into a broken view");
      await until("it launched", () => registry.isLaunched("t-1"));
      expect(broken.heard.filter((event) => event === "launched")).toHaveLength(1);
      await until("the log says the view threw", () => logged("onOutput threw") > 0);
    });

    it("keeps buffering for replay when its view throws on every chunk", async () => {
      const { d, registry } = await rig();
      const broken = view({ throwing: true });
      await start(d, registry, "t-1", true);
      registry.attach("t-1", broken.sink);
      await until("it is live", () => stateOf(registry, "t-1") === "live");
      cue(registry, "t-1", "say kept for later");
      await until("the broken view was handed it", () => printed(broken, "kept for later"));
      const late = view();
      registry.attach("t-1", late.sink);
      expect(printed(late, "kept for later")).toBe(true);
    });

    it("is not said before any output: a spawned terminal has not painted yet", async () => {
      const { d, registry } = await rig();
      const attached = view();
      await start(d, registry, "t-1", true);
      registry.attach("t-1", attached.sink);
      await until("it is ready", () => attached.heard.includes("ready"));
      await aWhile();
      expect(attached.heard).not.toContain("launched");
      expect(registry.isLaunched("t-1")).toBe(false);
      // Nor to a view attached to it live, before it has painted.
      const late = view();
      registry.attach("t-1", late.sink);
      expect(late.heard).toEqual(["ready"]);
    });

    it("is told a late view after its replay: the history paints, then the overlay drops", async () => {
      const { d, registry } = await rig();
      await start(d, registry, "t-1");
      await until("it printed", () => registry.isLaunched("t-1"));
      const late = view();
      registry.attach("t-1", late.sink);
      expect(late.heard.indexOf("output")).toBeGreaterThanOrEqual(0);
      expect(late.heard.indexOf("output")).toBeLessThan(late.heard.indexOf("launched"));
    });

    it("is forgotten when the identity changes: the new session shows its own overlay", async () => {
      const { d, registry } = await rig();
      await start(d, registry, "t-1");
      await until("it printed", () => registry.isLaunched("t-1"));
      registry.acquire("t-1", anotherIdentity(d.stubProcess(true)), await d.leaseLaunch());
      expect(registry.isLaunched("t-1")).toBe(false);
    });

    it("is never said for an unknown pane or a closed one", async () => {
      const { d, registry } = await rig();
      expect(registry.isLaunched("t-none")).toBe(false);
      await start(d, registry, "t-1");
      await until("it printed", () => registry.isLaunched("t-1"));
      void registry.close("t-1");
      expect(registry.isLaunched("t-1")).toBe(false);
    });
  });

  describe("closing a pane", () => {
    it("stops its live session and forgets it: a write after goes nowhere", async () => {
      const { d, registry } = await rig();
      await startLive(d, registry, "t-1");
      await registry.close("t-1");
      expect(stops()).toHaveLength(1);
      registry.write("t-1", "say too late\r");
      await aWhile();
      expect(written()).toEqual([]);
    });

    it("reaps a spawn that resolves after the pane was closed", async () => {
      const { d, registry } = await rig();
      const opening = host().hold({ reply: "pty_open" });
      await start(d, registry, "t-1");
      await opening.caught;
      void registry.close("t-1");
      opening.release();
      await until("the late session is stopped", () => stops().length === 1);
    });

    it("silences a closed pane: its process ending reaches no view", async () => {
      const { d, registry } = await rig();
      const attached = view();
      await start(d, registry, "t-1");
      registry.attach("t-1", attached.sink);
      await until("it is live", () => stateOf(registry, "t-1") === "live");
      await registry.close("t-1");
      await aWhile();
      expect(attached.heard.filter((event) => event.startsWith("exit"))).toEqual([]);
    });
  });

  describe("writing to a pane", () => {
    it("writes through to its live session", async () => {
      const { d, registry } = await rig();
      await startLive(d, registry, "t-1");
      const attached = view();
      registry.attach("t-1", attached.sink);
      cue(registry, "t-1", "say written through");
      await until("its process answers", () => printed(attached, "written through"));
      expect(written()).toEqual(["say written through\r"]);
    });

    it("drops a write to an unknown pane, or to one whose spawn is still out", async () => {
      const { d, registry } = await rig();
      expect(() => registry.write("t-none", "x")).not.toThrow();
      const opening = host().hold({ reply: "pty_open" });
      await start(d, registry, "t-1");
      await opening.caught;
      expect(() => registry.write("t-1", "say too soon\r")).not.toThrow();
      opening.release();
      await until("it is live", () => stateOf(registry, "t-1") === "live");
      await aWhile();
      expect(written()).toEqual([]);
    });
  });

  describe("the order of writes", () => {
    it("lands two writes made in one tick in the order they were made, one at a time", async () => {
      // The submit gesture is exactly this shape: the paste, then a bare CR,
      // both out in one breath. A CR that overtakes its paste spends itself
      // on an empty composer.
      const { d, registry } = await rig();
      await startLive(d, registry, "t-1");
      const attached = view();
      registry.attach("t-1", attached.sink);
      const landing = host().hold({ reply: "pty_write" });
      registry.write("t-1", "say the paste\r");
      registry.write("t-1", "say the return\r");
      await landing.caught;
      await aWhile();
      // One at a time: the second waits for the first to land.
      expect(written()).toEqual(["say the paste\r"]);
      landing.release();
      await until("both landed", () => printed(attached, "the return"));
      expect(written()).toEqual(["say the paste\r", "say the return\r"]);
      expect(printed(attached, "the paste")).toBe(true);
      expect(attached.text().indexOf("\nthe paste\r")).toBeLessThan(attached.text().indexOf("\nthe return\r"));
    });

    it("drops a write still queued when the pane closes, rather than sending it late", async () => {
      const { d, registry } = await rig();
      await startLive(d, registry, "t-1");
      const landing = host().hold({ reply: "pty_write" });
      registry.write("t-1", "say first\r");
      registry.write("t-1", "say second\r");
      await landing.caught;
      await registry.close("t-1");
      landing.release();
      await aWhile();
      expect(written()).toEqual(["say first\r"]);
    });
  });
});
