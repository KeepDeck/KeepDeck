import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDeck } from "../../../scripts/reporterHarness";
import { SHOW_WAIT_MS } from "../resources/keepdeck-plugin/courier-policy.js";
import { HEARTBEAT_MS } from "../resources/keepdeck-plugin/foreground.js";
import { LET_GO_MS } from "../resources/keepdeck-plugin/leaving.js";
import { requireHooks, type Armed } from "./resourceTestSupport.test-support";

/**
 * Leaving a conversation, and mail on the home screen (opencode 1.x,
 * task-435 §5.1 and §6). The user's rules: a conversation left — for
 * another, or for `/new` — stops and stops counting; mail goes only where
 * the user is looking; on the home screen a session is made for it, shown
 * first, and the mail asked for only once it is.
 *
 * The real reporter, courier and follower, against a stand-in deck, with
 * the screen written the way the TUI half writes it.
 *
 * Their clocks are the test's: the follower's heartbeat, the let-go's
 * fallback and the wait for a made session to come on screen run on fake
 * timers, which a case advances by the product's own constants. The
 * directory watchers and the deck's HTTP stay real — a positive signal, not
 * a sleep, is what a case waits for on them.
 */

type ReporterResult = Awaited<ReturnType<typeof import("../resources/keepdeck-plugin/session-reporter.js").startReporter>>;
type CourierResult = Awaited<ReturnType<typeof import("../resources/keepdeck-plugin/mail-courier.js").startCourier>>;
let startReporter: (input?: unknown) => Promise<Armed<ReporterResult, "event">>;
let startCourier: (input?: unknown) => Promise<Armed<CourierResult, "event" | "tool.execute.after">>;
let follower: () => { start(dir?: string): () => void };
let writeForeground: (dir: string, route: Record<string, unknown>) => void;
let paneSession: () => { root: string | undefined; left: string | undefined };
let drained: () => Promise<void>;

/** Taken before a case fakes timers: waiting on the real I/O is the test's,
 * on real time. */
const realSetTimeout = globalThis.setTimeout;
/** Wait for `done` — something the real watchers or the deck bring — up to
 * `ms` of wall-clock time. A ceiling that only a failure reaches, under the
 * case's own timeout so the failure says what it waited for. */
const until = async (done: () => boolean, ms = 4_000) => {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => realSetTimeout(resolve, 5));
};

/** Move the plugin's clock: run the timers due within `ms`, then one turn
 * of the event loop for what they started. */
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await new Promise((resolve) => setImmediate(resolve));
};

const created = (id: string, parentID?: string) => ({
  event: { type: "session.created", properties: { info: { id, parentID } } },
});
const idle = (sessionID: string) => ({ event: { type: "session.idle", properties: { sessionID } } });
const aborted = (sessionID: string) => ({
  event: {
    type: "session.error",
    properties: { sessionID, error: { name: "MessageAbortedError", data: {} } },
  },
});

describe("leaving a conversation, and mail on the home screen", () => {
  let dir: string;
  let deck: Awaited<ReturnType<typeof startDeck>>;
  /** What the stand-in deck hands out to the next mail asks. */
  let pending: unknown[];
  let parents: Record<string, string | undefined>;
  let calls: { abort: string[]; create: number; select: string[]; prompts: { id: string; body: unknown }[] };
  /** What the TUI does when told to show a session; null = it does not. */
  let onSelect: ((id: string) => void) | null;
  /** Fired between `session.create` being called and returning — the user
   * sending their own first prompt at that moment. */
  let duringCreate: (() => Promise<void>) | null;
  /** The follower's own stop: its heartbeat and its directory watcher. (The
   * 1.x courier's doorbell has none — opencode 1.x gives a plugin no
   * cleanup, so it lives as long as the process.) */
  let stopFollowing: () => void;
  let reporter: Armed<ReporterResult, "event">;
  let courier: Armed<CourierResult, "event" | "tool.execute.after">;

  const both = async (event: Parameters<typeof reporter.event>[0]) => {
    await reporter.event(event);
    await courier.event(event);
  };

  const client = () => ({
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: parents[path.id] } }),
      messages: async ({ path }: { path: { id: string } }) => ({
        data:
          path.id === "ses_a"
            ? [
                {
                  info: {
                    role: "user",
                    agent: "custom",
                    model: { providerID: "probe", modelID: "alt", variant: "max" },
                  },
                  parts: [{ type: "text", text: "my own words" }],
                },
              ]
            : [],
      }),
      children: async () => ({ data: [] }),
      abort: async ({ path }: { path: { id: string } }) => {
        calls.abort.push(path.id);
        return { data: true };
      },
      create: async () => {
        calls.create += 1;
        if (duringCreate) await duringCreate();
        return { data: { id: "ses_c" } };
      },
      promptAsync: async ({ path, body }: { path: { id: string }; body: unknown }) => {
        calls.prompts.push({ id: path.id, body });
        return { data: {} };
      },
    },
    tui: {
      publish: async ({ body }: { body: { properties: { sessionID: string } } }) => {
        calls.select.push(body.properties.sessionID);
        onSelect?.(body.properties.sessionID);
        return { data: true };
      },
    },
    config: { providers: async () => ({ data: { providers: [] } }) },
  });

  beforeEach(async () => {
    vi.resetModules();
    // The plugin's timers only — before the follower starts its heartbeat.
    // Date stays real: the deck's arrival stamps and `until` read it.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const reporterResource = await import("../resources/keepdeck-plugin/session-reporter.js");
    const courierResource = await import("../resources/keepdeck-plugin/mail-courier.js");
    startReporter = async (input) => requireHooks(await reporterResource.startReporter(input), ["event"]);
    startCourier = async (input) => requireHooks(await courierResource.startCourier(input), ["event", "tool.execute.after"]);
    ({ follower } = await import("../resources/keepdeck-plugin/follower.js"));
    ({ writeForeground } = await import("../resources/keepdeck-plugin/foreground.js"));
    ({ paneSession } = await import("../resources/keepdeck-plugin/pane-session.js"));
    ({ drained } = await import("../resources/keepdeck-plugin/keepdeck-bridge.js"));
    dir = mkdtempSync(join(tmpdir(), "kd-leave-"));
    pending = [];
    holdBound = undefined;
    arrived = {};
    deck = await startDeck((envelope) => {
      const type = envelope?.payload?.event?.type;
      arrived[envelope?.type === "agent.status" ? type : envelope?.type] ??= Date.now();
      if (envelope?.type === "session.bound" && envelope?.payload?.sessionId === holdBound) {
        return { status: 204, holdMs: BOUND_HOLD_MS };
      }
      if (type !== "mail.ask" && type !== "mail.ask.tool") return { status: 204 };
      const answer = pending.shift();
      return answer ? { status: 200, body: JSON.stringify(answer) } : { status: 204 };
    });
    process.env.KEEPDECK_BRIDGE = JSON.stringify({ v: 2, dir, pane: "pane-3", token: "tok", url: deck.url });
    parents = {};
    calls = { abort: [], create: 0, select: [], prompts: [] };
    onSelect = (id) => {
      // The TUI shows it, and opencode publishes the session it made.
      writeForeground(dir, { route: "session", sessionID: id });
    };
    duringCreate = null;
    const c = client();
    reporter = await startReporter({ client: c });
    courier = await startCourier({ client: c });
    stopFollowing = follower().start(dir);
  });

  afterEach(async () => {
    stopFollowing();
    delete process.env.KEEPDECK_BRIDGE;
    // Nothing still on the wire when the deck goes: a post in flight would
    // land on a closed server.
    await drained();
    await deck.close();
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** How long the deck holds that binding's post open. */
  const BOUND_HOLD_MS = 300;
  /** A binding whose post the deck holds open — the wire is busy with it. */
  let holdBound: string | undefined;
  /** When each kind of envelope first arrived. */
  let arrived: Record<string, number>;

  const kinds = () =>
    deck.envelopes.map((e) => (e.type === "agent.status" ? e.payload?.event?.type : e.type));

  /** The pane working in `ses_a`, shown on screen. */
  const inA = async () => {
    await both(created("ses_a"));
    writeForeground(dir, { route: "session", sessionID: "ses_a" });
    await until(() => kinds().includes("session.bound"));
    // The follower has read the screen by its next heartbeat at the latest:
    // the directory watcher can drop the write's event, and a home screen it
    // never saw a session before is not a leaving.
    await advance(HEARTBEAT_MS);
  };

  /** A screen the user moved to, as the follower reads it: at once from the
   * watcher, and by the next heartbeat whatever the watcher did. */
  const show = async (route: Record<string, unknown>) => {
    writeForeground(dir, route);
    await advance(HEARTBEAT_MS);
  };

  /** The user pressed /new; opencode answers the abort with its ending — or,
   * with `answerAbort` false, never does, and the fallback lets go. */
  const newSession = async ({ answerAbort = true } = {}) => {
    await show({ route: "home" });
    await until(() => calls.abort.length > 0);
    if (answerAbort) {
      await both(aborted("ses_a"));
      await both(idle("ses_a"));
    } else {
      await advance(LET_GO_MS);
    }
    await until(() => kinds().includes("session.unbound"));
    expect(kinds()).toContain("session.unbound");
  };

  const ring = () => writeFileSync(join(dir, "mail.wake"), "");

  /**
   * Ring until `done`, re-ringing while nothing happens — as the deck does: a
   * ring is a file event, and under load the watcher can fold or drop one.
   * The deck re-rings a pane whose mail still waits, so a test that rang
   * once would assert something the product does not promise.
   */
  const ringUntil = async (done: () => boolean) => {
    for (let rings = 0; rings < 6 && !done(); rings++) {
      ring();
      await until(done, 500);
    }
  };

  it("/new aborts the turn left, tells the deck it ended, and only then lets the session go", async () => {
    await inA();
    await newSession();
    expect(calls.abort).toEqual(["ses_a"]);
    const order = kinds();
    // The ending reaches the deck as the pane's, so it does not stay "working".
    expect(order.indexOf("session.idle")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("session.unbound")).toBeGreaterThan(order.indexOf("session.idle"));
    expect(paneSession().root).toBeUndefined();
    expect(paneSession().left).toBe("ses_a");
  });

  it("forgets what it said about the left conversation's turn — the next one's first ending still reaches the deck", async () => {
    await inA();
    await newSession();
    deck.envelopes.length = 0;
    // The abort's idle was the last turn fact said. The next conversation
    // going idle is a fact about IT, not a repeat.
    await both(created("ses_b"));
    await both(idle("ses_b"));
    await until(() => kinds().includes("session.idle"));
    expect(kinds()).toContain("session.idle");
  });

  it("lets go at once on /new from an idle conversation — its abort's idle only repeats one", async () => {
    // The deck was already told the turn ended; the abort's idle is a repeat
    // the reporter does not forward, and it must still be what lets go —
    // not the 3 s fallback (measured live, task-444). The fallback's clock
    // never moves here, so only the idle can let go.
    await inA();
    await both(idle("ses_a"));
    await show({ route: "home" });
    await until(() => calls.abort.length > 0);
    expect(calls.abort).toEqual(["ses_a"]);
    await both(idle("ses_a"));
    await until(() => kinds().includes("session.unbound"));
    expect(kinds()).toContain("session.unbound");
  });

  it("lets go even when the abort brings no ending", async () => {
    await inA();
    await newSession({ answerAbort: false });
    expect(kinds()).toContain("session.unbound");
    expect(paneSession().root).toBeUndefined();
  });

  it("never lets the session left — or its subagents — speak for the pane again", async () => {
    await inA();
    await newSession();
    deck.envelopes.length = 0;
    parents.ses_sub = "ses_a";
    await both(created("ses_sub", "ses_a"));
    await both({ event: { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } } });
    await both(idle("ses_a"));
    await deck.idle();
    expect(paneSession().root).toBeUndefined();
    expect(kinds()).not.toContain("session.bound");
    expect(kinds()).not.toContain("session.idle");
  });

  it("aborts nothing when opencode merely STARTS on the home screen", async () => {
    // A fresh process shows home before `-s` opens; the native fork stays
    // there until its session exists. Neither is the user leaving.
    await show({ route: "home" });
    await both(created("ses_a"));
    await show({ route: "session", sessionID: "ses_a" });
    expect(calls.abort).toEqual([]);
    expect(kinds()).not.toContain("session.unbound");
  });

  it("aborts nothing when the first screen this process shows is home, even with the pane bound", async () => {
    // The observer loads seconds after opencode starts; the pane can be bound
    // from its events before the first screen is written. Home FIRST is not
    // a move from anywhere.
    await both(created("ses_a"));
    await until(() => kinds().includes("session.bound"));
    await show({ route: "home" });
    expect(calls.abort).toEqual([]);
    expect(paneSession().root).toBe("ses_a");
  });

  it("does not forget the conversation the user started before the late let-go", async () => {
    // No ending came for the abort; before the fallback, the user's first
    // prompt from home made their own session. Letting go now would unbind
    // THEIR conversation.
    await inA();
    await show({ route: "home" });
    await until(() => calls.abort.length > 0);
    await both(created("ses_u"));
    await advance(LET_GO_MS);
    await deck.idle();
    expect(paneSession().root).toBe("ses_u");
    expect(kinds()).not.toContain("session.unbound");
  });

  it("aborts the conversation the user switches away from, and moves to the new one", async () => {
    await inA();
    await show({ route: "session", sessionID: "ses_b" });
    await until(() => paneSession().root === "ses_b");
    expect(calls.abort).toEqual(["ses_a"]);
    expect(kinds()).not.toContain("session.unbound");
  });

  it("aborts nothing for a look at one of the conversation's own subagents", async () => {
    await inA();
    parents.ses_sub = "ses_a";
    await both(created("ses_sub", "ses_a"));
    await show({ route: "session", sessionID: "ses_sub" });
    expect(calls.abort).toEqual([]);
    expect(paneSession().root).toBe("ses_a");
  });

  it("asks for the home screen's mail only once the new session's binding has gone out", async () => {
    await inA();
    await newSession();
    arrived = {};
    holdBound = "ses_c";
    duringCreate = async () => {
      await reporter.event(created("ses_c"));
      void courier.event(created("ses_c"));
    };
    pending.push({ v: 1, prompt: "<teammate-message>\n> do it\n</teammate-message>" });
    await ringUntil(() => calls.create > 0);
    await until(() => calls.prompts.length === 1);
    // The ask is not on the wire's queue: without waiting for it to drain,
    // it would reach the deck while the binding is still in flight. Not a
    // moment later — only once the binding's response was given.
    expect(arrived["mail.ask"] - arrived["session.bound"]).toBeGreaterThanOrEqual(BOUND_HOLD_MS);
  });

  it("on the home screen, mail gets a session of its own — shown first, asked for after", async () => {
    await inA();
    await newSession();
    deck.envelopes.length = 0;
    // As opencode does it: the new session is announced BEFORE `create`
    // returns (measured live, task-444). Told to the courier without waiting:
    // its handler queues behind the very job making this call.
    duringCreate = async () => {
      await reporter.event(created("ses_c"));
      void courier.event(created("ses_c"));
    };
    pending.push({ v: 1, context: "you are analyst-2", prompt: "<teammate-message>\n> do it\n</teammate-message>" });
    await ringUntil(() => calls.create > 0);
    await until(() => calls.prompts.length === 2);

    expect(calls.create).toBe(1);
    expect(calls.select).toEqual(["ses_c"]);
    // The mail was asked for only after the session was shown and bound.
    const order = kinds();
    expect(order.indexOf("session.bound")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("mail.ask")).toBeGreaterThan(order.indexOf("session.bound"));
    // Into the new session, the brief with the mail, as the user's last
    // prompt in the conversation they left ran.
    const chosen = { agent: "custom", model: { providerID: "probe", modelID: "alt" }, variant: "max" };
    expect(calls.prompts.map((p) => p.id)).toEqual(["ses_c", "ses_c"]);
    expect(calls.prompts[0].body).toMatchObject({ ...chosen, noReply: true });
    expect(calls.prompts[1].body).toMatchObject(chosen);
  });

  it("takes no mail, and makes no more sessions, when the TUI never shows the one made", async () => {
    await inA();
    await newSession();
    deck.envelopes.length = 0;
    onSelect = null;
    duringCreate = async () => {
      await reporter.event(created("ses_c"));
      void courier.event(created("ses_c"));
    };
    pending.push({ v: 1, prompt: "<teammate-message>\n> do it\n</teammate-message>" });
    await ringUntil(() => calls.create > 0);
    // The made session never comes on screen within the wait, and the
    // courier asks nothing. That the wait then gives up is the policy's own
    // rule, held where it lives (courierPolicy.test.ts).
    await advance(SHOW_WAIT_MS);
    await deck.idle();
    expect(kinds()).not.toContain("mail.ask");
    expect(pending).toHaveLength(1);
    // The deck rings again: the ring is taken, and nothing is tried until
    // the screen changes.
    await ringUntil(() => !existsSync(join(dir, "mail.wake")));
    expect(calls.create).toBe(1);
  });

  it("makes no session on the home screen when nothing rang — the user may have no mail at all", async () => {
    await inA();
    await newSession();
    await advance(SHOW_WAIT_MS);
    expect(calls.create).toBe(0);
  });

  it("stops when the user starts a conversation of their own meanwhile — theirs is on screen", async () => {
    await inA();
    await newSession();
    duringCreate = async () => {
      // The user's first prompt from home mints their own session. Told to
      // the courier without waiting: its handler queues behind the very job
      // that is making this call.
      await reporter.event(created("ses_u"));
      void courier.event(created("ses_u"));
    };
    pending.push({ v: 1, prompt: "<teammate-message>\n> do it\n</teammate-message>" });
    await ringUntil(() => calls.create > 0);
    await until(() => calls.prompts.length > 0);
    expect(calls.create).toBe(1);
    expect(calls.select).toEqual([]);
    // Their session is the pane's, and the mail went there.
    expect(paneSession().root).toBe("ses_u");
    expect(calls.prompts.every((p) => p.id === "ses_u")).toBe(true);
  });

  it("does not ride mail into the left conversation's still-running turn", async () => {
    await inA();
    await show({ route: "home" });
    await until(() => calls.abort.length > 0);
    // Before its ending arrives, a tool call of the left turn returns.
    deck.envelopes.length = 0;
    pending.push({ v: 1, prompt: "<teammate-message>\n> do it\n</teammate-message>" });
    const output = { title: "bash", output: "ok", metadata: {} };
    await courier["tool.execute.after"]({ tool: "bash", sessionID: "ses_a", callID: "c1" }, output);
    expect(output.output).toBe("ok");
    expect(kinds()).not.toContain("mail.ask.tool");
  });
});
