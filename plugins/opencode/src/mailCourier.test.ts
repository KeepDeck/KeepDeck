import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The courier is untyped resource JS — it is shipped to, and loaded by, the
// user's opencode process, never bundled into the plugin.
// @ts-expect-error untyped resource module
import courierPlugin from "../resources/mail-courier.js";
// The pane's session is ONE object per process — which is the point of it,
// and which makes a suite of many panes in one process need a fresh start.
// @ts-expect-error untyped resource module
import { resetPaneSession } from "../resources/pane-session.js";
import { startDeck } from "../../../scripts/reporterHarness";

/**
 * This suite runs the courier on its REAL clock.
 *
 * A doorbell ring travels through the filesystem and the ask that follows is
 * a real HTTP round trip to the stand-in deck below, so a single delivery
 * takes tens of milliseconds — and under the full parallel suite, more.
 * Nothing here is a latency assertion, so the ceiling is generous and the
 * waits below stay well inside it.
 *
 * It used to be far slower and this ceiling used to say why: the courier
 * polled a directory for its answer over a two-second window and the fake
 * deck was a polling loop of its own. Neither exists — the answer comes back
 * on the connection the question went out on.
 */
vi.setConfig({ testTimeout: 10_000 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const last = <T,>(items: T[]): T | undefined => items[items.length - 1];

/** An opencode `session.created` event; `parentID` marks a CHILD session. */
const created = (id: string, parentID?: string) => ({
  event: { type: "session.created", properties: { info: { id, parentID } } },
});
const idle = (sessionID: string) => ({
  event: { type: "session.idle", properties: { sessionID } },
});
const busy = (sessionID: string) => ({
  event: {
    type: "session.status",
    properties: { sessionID, status: { type: "busy" } },
  },
});

interface PromptBody {
  noReply?: boolean;
  parts?: { type: string; text: string; synthetic?: boolean }[];
}
interface PromptCall {
  sessionID?: string;
  body?: PromptBody;
}

/**
 * The one contract this suite exists to hold: the SHAPE opencode's plugin
 * client accepts, and the way it reports a shape it does not.
 *
 * Measured against opencode 1.18.15, by loading a probe plugin into a live
 * `opencode serve` and calling both forms:
 *
 *   session.promptAsync({sessionID, ...})        → {error: UnknownError}
 *   session.promptAsync({path:{id}, body:{...}}) → {data: {}}
 *   tui.appendPrompt({text})                     → {error: BadRequest}
 *   tui.appendPrompt({body:{text}})              → {data: true}
 *
 * The failure mode is what makes this worth a fake of its own: the client
 * RESOLVES with `{error}` instead of throwing. The courier's first version
 * sent the flat form and awaited it inside a try/catch, so every delivery it
 * ever made was dropped and every test passed — because the fake accepted
 * whatever it was handed. A stub that says yes to everything tests nothing.
 */
const rejectsFlat = <T,>(call: Record<string, unknown>, accept: () => T) =>
  call.path === undefined && call.body === undefined
    ? { error: { name: "UnknownError" } }
    : accept();

describe("opencode mail courier", () => {
  let dir: string;
  let prompts: PromptCall[];
  let submitted: string[];
  let client: Record<string, unknown>;
  /** Answers the fake deck will hand out, in order. Anything asked past the
   * end gets "" — which is what the real deck answers most of the time. */
  /** sessionId → parent, as the client would answer. Absent = a root. */
  let parents: Record<string, string | undefined>;
  let pending: unknown[];
  /** Every question the courier asked, in order. */
  let asked: { paneId: string; payload: Record<string, string> }[];

  let deck: Awaited<ReturnType<typeof startDeck>>;

  /**
   * Stand in for the deck's side of the bridge: take every question and
   * ALWAYS answer it. Answering everything is not test convenience — it is
   * what the deck does, because an asker left unanswered waits out its whole
   * timeout, and a test that answered selectively would stall the courier on
   * every turn that had no mail.
   */
  const answerAsk = (envelope: any) => {
    if (envelope?.payload?.event?.type !== "mail.ask") return { status: 204 };
    asked.push(envelope);
    const answer = pending.shift();
    const body =
      answer === undefined
        ? ""
        : typeof answer === "string"
          ? answer
          : JSON.stringify(answer);
    // 204 for an empty answer, exactly as the deck's own route does: nothing
    // was waiting, and that is a different thing from an answer that is blank.
    return body ? { status: 200, body } : { status: 204 };
  };

  beforeEach(async () => {
    resetPaneSession();
    dir = mkdtempSync(join(tmpdir(), "kd-courier-"));
    deck = await startDeck(answerAsk);
    process.env.KEEPDECK_BRIDGE = JSON.stringify({
      v: 2,
      dir,
      pane: "pane-3",
      token: "tok",
      url: deck.url,
    });
    prompts = [];
    submitted = [];
    pending = [];
    asked = [];
    parents = {};
    client = {
      session: {
        // How the courier asks whether a session is somebody's child before
        // adopting it as the pane's own conversation.
        get: async (call: Record<string, unknown>) =>
          rejectsFlat(call, () => {
            const id = (call.path as { id: string }).id;
            return { data: { id, parentID: parents[id] } };
          }),
        promptAsync: async (call: Record<string, unknown>) =>
          rejectsFlat(call, () => {
            prompts.push({
              sessionID: (call.path as { id: string } | undefined)?.id,
              body: call.body as PromptBody,
            });
            return { data: {} };
          }),
      },
      tui: {
        appendPrompt: async (call: Record<string, unknown>) =>
          rejectsFlat(call, () => {
            submitted.push((call.body as { text: string }).text);
            return { data: true };
          }),
        submitPrompt: async () => {
          submitted.push("<submit>");
          return { data: true };
        },
      },
    };
  });

  afterEach(async () => {
    delete process.env.KEEPDECK_BRIDGE;
    await deck.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const start = () => courierPlugin({ client });

  /**
   * Ring the deck's doorbell and wait, RE-ringing while nothing happens.
   *
   * Not test-flavoured patience: a ring is consumed the moment the courier
   * notices it, and if the ask that follows times out — which it will if this
   * process is starved past the courier's two-second window — the ring is
   * gone and nothing retries it. The deck behaves exactly the same way and
   * re-nudges a pane whose mail is still queued, so a test that rang once and
   * waited was asserting something the product does not promise.
   */
  const ringUntil = async (done: () => boolean) => {
    for (let rings = 0; rings < 12 && !done(); rings++) {
      writeFileSync(join(dir, "mail.wake"), "");
      for (let tries = 0; tries < 100 && !done(); tries++) await sleep(5);
    }
  };

  it("puts the standing brief in the session without starting a turn", async () => {
    // The whole reason this plugin exists. A brief is not something somebody
    // said — it is where the pane stands from now on — so it is stored and
    // nothing runs. `synthetic` keeps a wall of setup text out of the
    // transcript the user is reading; opencode marks its own injections the
    // same way.
    const courier = await start();
    pending.push({ v: 1, context: "you are impl-1" });
    await courier.event(created("ses_root"));

    expect(prompts).toEqual([
      {
        sessionID: "ses_root",
        body: {
          noReply: true,
          parts: [{ type: "text", text: "you are impl-1", synthetic: true }],
        },
      },
    ]);
  });

  it("spends a turn on somebody's words, and shows them", async () => {
    // The other half. A message nobody reads until the user next happens to
    // type is not delivered in any sense that matters — so it runs. And it is
    // NOT synthetic: the person watching should see what arrived and why
    // their agent just moved.
    const courier = await start();
    await courier.event(created("ses_root"));
    pending.push({ v: 1, prompt: "ship it" });
    await courier.event(idle("ses_root"));

    expect(last(prompts)).toEqual({
      sessionID: "ses_root",
      body: { parts: [{ type: "text", text: "ship it" }] },
    });
    expect(last(prompts)?.body).not.toHaveProperty("noReply");
  });

  it("rides the user's own message when there is one, spending nothing", async () => {
    // The cheapest delivery there is: no extra turn, no wake. The parts have
    // to be in place before the request is built, which is why this hook is
    // awaited and the injection is not a prompt of its own.
    const courier = await start();
    await courier.event(created("ses_root"));
    const output = { message: {}, parts: [{ type: "text", text: "hi" }] };
    pending.push({ v: 1, context: "you are impl-1", prompt: "ship it" });
    await courier["chat.message"]({ sessionID: "ses_root" }, output);

    expect(output.parts).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "you are impl-1", synthetic: true },
      { type: "text", text: "ship it" },
    ]);
    // Nothing was prompted separately — that is the point of riding along.
    expect(prompts).toEqual([]);
  });

  it("answers the deck's doorbell, and takes it down", async () => {
    // The idle case: mail waiting, no turn boundary coming, and nothing
    // typed at the pane. Taking the file down IS reading it — it carries
    // nothing, because everything about the mail is in the answer.
    const courier = await start();
    await courier.event(created("ses_root"));
    prompts.length = 0;
    pending.push({ v: 1, prompt: "ship it" });
    await ringUntil(() => prompts.length > 0);

    expect(existsSync(join(dir, "mail.wake"))).toBe(false);
    expect(last(prompts)?.body?.parts?.[0]?.text).toBe("ship it");
  });

  it("leaves a doorbell rung mid-turn to the boundary that is already coming", async () => {
    // Injecting into a running turn is not something opencode promises
    // anything about, and the session.idle closing that turn collects moments
    // later — so the wake is consumed and the delivery waits for it.
    const courier = await start();
    await courier.event(created("ses_root"));
    await courier.event(busy("ses_root"));
    prompts.length = 0;
    asked.length = 0;
    writeFileSync(join(dir, "mail.wake"), "");
    await sleep(60);
    expect(asked).toEqual([]);

    pending.push({ v: 1, prompt: "ship it" });
    await courier.event(idle("ses_root"));
    expect(last(prompts)?.body?.parts?.[0]?.text).toBe("ship it");
  });

  it("submits through opencode's own prompt when no session exists yet", async () => {
    // opencode mints a session at the first message, so a pane nobody has
    // spoken to has nothing to inject into. This is what a keystroke would
    // do, minus the keystroke — and both halves go together, because they
    // land in the same first turn and the deck has already handed them over.
    await start();
    pending.push({ v: 1, context: "brief", prompt: "ship it" });
    await ringUntil(() => submitted.length > 1);

    expect(submitted).toEqual(["brief\n\nship it", "<submit>"]);
    expect(prompts).toEqual([]);
  });

  it("asks on the connection and leaves nothing in the run directory", async () => {
    // The cutoff. The answer used to be a file this had to read AND remove,
    // where the removal was the deck's only evidence that anyone had taken
    // the mail — a courier that read without removing silently duplicated
    // every message. There is no file: the deck learns from the send, and
    // the run directory holds nothing but the doorbell.
    const courier = await start();
    pending.push({ v: 1, context: "brief" });
    await courier.event(created("ses_root"));
    const envelope = last(asked)!;
    expect(readdirSync(dir)).toEqual([]);
    // And the question named this pane, with the same process the reporter
    // beside it names — the deck pins a pane's identity to one process.
    expect(envelope.paneId).toBe("pane-3");
    expect(envelope.payload.reporter).toBe(String(process.pid));
    expect(
      (envelope.payload.event as unknown as { type: string }).type,
    ).toBe("mail.ask");
  });

  it("injects nothing on an empty answer or one it cannot read", async () => {
    // Empty is the common answer and a real one. A version this file does not
    // know is dropped whole rather than half-applied: a pane spawned before
    // an update is still running this exact code.
    const courier = await start();
    pending.push("");
    await courier.event(created("ses_root"));
    expect(prompts).toEqual([]);

    pending.push({ v: 99, prompt: "from the future" });
    await courier.event(idle("ses_root"));
    expect(prompts).toEqual([]);
  });

  it("never mistakes a subagent's session for the pane's own", async () => {
    // The task tool creates child sessions in this same process. Binding to
    // one would follow a transient leaf, and a child going idle is not the
    // pane's turn ending.
    const courier = await start();
    await courier.event(created("ses_child", "ses_root"));
    pending.push({ v: 1, prompt: "ship it" });
    await ringUntil(() => submitted.length > 0);
    // No root was ever adopted, so this went the no-session way.
    expect(prompts).toEqual([]);
    expect(submitted[0]).toBe("ship it");
  });

  it("falls through to the TUI when the session refuses the delivery", async () => {
    // The client resolves with `{error}` rather than throwing, so a refusal
    // reads as success unless it is checked. It went unchecked once and every
    // message this courier carried was dropped in silence. The deck books a
    // message the moment it hands it over, so there is nothing to retry with
    // — a visible delivery beats a tidy failure nobody hears about.
    (client.session as { promptAsync: unknown }).promptAsync = async () => ({
      error: { name: "UnknownError" },
    });
    const courier = await start();
    await courier.event(created("ses_root"));
    pending.push({ v: 1, prompt: "ship it" });
    await courier.event(idle("ses_root"));

    expect(submitted).toEqual(["ship it", "<submit>"]);
  });

  it("finds its session on a RESUMED pane, which fires no session.created", async () => {
    // `opencode -s <id>` is how every pane comes back after a restart, and it
    // starts no session — so a courier that only learned its root from
    // `session.created` never had one. Everything downstream then failed
    // quietly: the turn boundary collected nothing and every doorbell fell
    // through to the TUI.
    const courier = await start();
    pending.push({ v: 1, prompt: "ship it" });
    await courier.event(idle("ses_resumed"));

    expect(last(prompts)).toEqual({
      sessionID: "ses_resumed",
      body: { parts: [{ type: "text", text: "ship it" }] },
    });
    expect(submitted).toEqual([]);
  });

  it("asks whether a session is a child before taking it as the pane's", async () => {
    // The task tool creates children in this same process, and on a resumed
    // pane a child's event can be the first one seen. Adopting it would bind
    // the pane to a leaf that ends, so the courier asks.
    parents.ses_child = "ses_root";
    const courier = await start();
    pending.push({ v: 1, prompt: "ship it" });
    await courier.event(idle("ses_child"));
    // Not adopted: nothing was collected, and the child's idle is not the
    // pane's turn ending.
    expect(prompts).toEqual([]);
    expect(asked).toEqual([]);

    // The root's own idle is, and it still gets adopted afterwards.
    await courier.event(idle("ses_root"));
    expect(last(prompts)?.sessionID).toBe("ses_root");
  });

  it("binds to the child's ROOT, so a doorbell reaches the session and not the TUI", async () => {
    // The other half of the ask above, and the case the shared index exists
    // for. Declining a child left the courier bound to NOTHING on a pane
    // resumed mid-task: every doorbell fell through to `appendPrompt`, the
    // degraded path, while the reporter beside it had already bound the pane
    // to the same root from the same evidence. Two plugins, one process, two
    // answers.
    parents.ses_child = "ses_root";
    const courier = await start();
    await courier.event(idle("ses_child"));
    prompts.length = 0;
    submitted.length = 0;

    pending.push({ v: 1, prompt: "ship it" });
    await ringUntil(() => prompts.length > 0 || submitted.length > 0);

    // Into the pane's real conversation, through the session — not typed at
    // the TUI, which is what "bound to nothing" produces.
    expect(last(prompts)?.sessionID).toBe("ses_root");
    expect(submitted).toEqual([]);
  });

  it("keeps the first session it bound, not the last answer to come back", async () => {
    // `adoptRoot` checked `activeRoot` BEFORE its round trip and assigned
    // after, and `chat.message` calls it outside the delivery queue — so two
    // events could both pass the guard and the slower answer would win. An
    // unrelated subagent's chain takes an extra hop, which makes it reliably
    // the slower one, and the pane was rebound to somebody else's
    // conversation for the life of the process.
    parents.ses_alien_child = "ses_alien_root";
    const session = client.session as {
      get: (call: Record<string, unknown>) => Promise<unknown>;
    };
    const answer = session.get;
    // The alien's answer comes back LAST, deterministically — which is what
    // an extra hop up a chain buys it in practice.
    session.get = async (call: Record<string, unknown>) => {
      if ((call.path as { id: string }).id.startsWith("ses_alien")) {
        await sleep(30);
      }
      return answer(call);
    };

    const courier = await start();
    // `event` is serialized through the courier's own queue; `chat.message`
    // deliberately is NOT — it has to await its own answer before the request
    // is built. That is the pair that can overlap, and the alien's extra hop
    // makes it the slower of the two.
    const alien = courier.event(idle("ses_alien_child"));
    await courier["chat.message"]({ sessionID: "ses_mine" }, { parts: [] });
    await alien;

    // The pane kept the identity it bound first.
    prompts.length = 0;
    pending.push({ v: 1, prompt: "ship it" });
    await courier.event(idle("ses_mine"));
    expect(last(prompts)?.sessionID).toBe("ses_mine");
  });

  it("stays inert outside KeepDeck", async () => {
    // A user's own opencode, or a KeepDeck too old to set the variable. It
    // must not ask, must not watch, and must not touch their session.
    delete process.env.KEEPDECK_BRIDGE;
    expect(await start()).toEqual({});
    expect(readdirSync(dir)).toEqual([]);
  });
});
