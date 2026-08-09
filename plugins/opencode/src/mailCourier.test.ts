import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The courier is untyped resource JS — it is shipped to, and loaded by, the
// user's opencode process, never bundled into the plugin.
// @ts-expect-error untyped resource module
import courierPlugin from "../resources/mail-courier.js";

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

interface PromptCall {
  sessionID?: string;
  noReply?: boolean;
  parts?: { type: string; text: string; synthetic?: boolean }[];
}

describe("opencode mail courier", () => {
  let dir: string;
  let prompts: PromptCall[];
  let submitted: string[];
  let client: Record<string, unknown>;
  /** Answers the fake deck will hand out, in order. Anything asked past the
   * end gets "" — which is what the real deck answers most of the time. */
  let pending: unknown[];
  /** Every question the courier asked, in order. */
  let asked: { paneId: string; payload: Record<string, string> }[];
  let deckRunning: boolean;

  /**
   * Stand in for the deck's side of the bridge: consume every question and
   * ALWAYS answer it. Answering everything is not test convenience — it is
   * what the deck does, because a hook left with no file waits out its whole
   * timeout, and a test that answered selectively would leave the courier
   * polling for two seconds on every turn that had no mail.
   */
  const runDeck = async () => {
    while (deckRunning) {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith("agent.status-") || !name.endsWith(".json")) {
          continue;
        }
        const path = join(dir, name);
        const envelope = JSON.parse(readFileSync(path, "utf8"));
        rmSync(path, { force: true });
        asked.push(envelope);
        const answer = pending.shift();
        writeFileSync(
          join(dir, `${envelope.payload.reply}.reply`),
          answer === undefined
            ? ""
            : typeof answer === "string"
              ? answer
              : JSON.stringify(answer),
        );
      }
      await sleep(2);
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kd-courier-"));
    process.env.KEEPDECK_BRIDGE = JSON.stringify({
      v: 1,
      dir,
      pane: "pane-3",
      token: "tok",
    });
    prompts = [];
    submitted = [];
    pending = [];
    asked = [];
    deckRunning = true;
    void runDeck();
    client = {
      session: {
        promptAsync: async (call: PromptCall) => void prompts.push(call),
      },
      tui: {
        appendPrompt: async ({ text }: { text: string }) =>
          void submitted.push(text),
        submitPrompt: async () => void submitted.push("<submit>"),
      },
    };
  });

  afterEach(() => {
    deckRunning = false;
    delete process.env.KEEPDECK_BRIDGE;
    rmSync(dir, { recursive: true, force: true });
  });

  const start = () => courierPlugin({ client });

  /** Wait for something the courier does on its own clock (a doorbell it
   * noticed, not a hook we called). */
  const until = async (done: () => boolean) => {
    for (let tries = 0; tries < 200 && !done(); tries++) await sleep(5);
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
        noReply: true,
        parts: [{ type: "text", text: "you are impl-1", synthetic: true }],
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
      parts: [{ type: "text", text: "ship it" }],
    });
    expect(last(prompts)).not.toHaveProperty("noReply");
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
    writeFileSync(join(dir, "pane-3.wake"), "");
    await until(() => prompts.length > 0);

    expect(existsSync(join(dir, "pane-3.wake"))).toBe(false);
    expect(last(prompts)?.parts?.[0]?.text).toBe("ship it");
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
    writeFileSync(join(dir, "pane-3.wake"), "");
    await sleep(60);
    expect(asked).toEqual([]);

    pending.push({ v: 1, prompt: "ship it" });
    await courier.event(idle("ses_root"));
    expect(last(prompts)?.parts?.[0]?.text).toBe("ship it");
  });

  it("submits through opencode's own prompt when no session exists yet", async () => {
    // opencode mints a session at the first message, so a pane nobody has
    // spoken to has nothing to inject into. This is what a keystroke would
    // do, minus the keystroke — and both halves go together, because they
    // land in the same first turn and the deck has already handed them over.
    await start();
    pending.push({ v: 1, context: "brief", prompt: "ship it" });
    writeFileSync(join(dir, "pane-3.wake"), "");
    await until(() => submitted.length > 1);

    expect(submitted).toEqual(["brief\n\nship it", "<submit>"]);
    expect(prompts).toEqual([]);
  });

  it("collects the answer file so the deck knows the mail was taken", async () => {
    // The removal is the ONLY evidence the deck has. A reply left on disk
    // means the messages in it were handed over and lost, and it puts them
    // back — so a courier that read without removing would silently
    // duplicate every message it ever delivered.
    const courier = await start();
    pending.push({ v: 1, context: "brief" });
    await courier.event(created("ses_root"));
    const envelope = last(asked)!;
    expect(existsSync(join(dir, `${envelope.payload.reply}.reply`))).toBe(false);
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
    writeFileSync(join(dir, "pane-3.wake"), "");
    await until(() => submitted.length > 0);
    // No root was ever adopted, so this went the no-session way.
    expect(prompts).toEqual([]);
    expect(submitted[0]).toBe("ship it");
  });

  it("stays inert outside KeepDeck", async () => {
    // A user's own opencode, or a KeepDeck too old to set the variable. It
    // must not ask, must not watch, and must not touch their session.
    delete process.env.KEEPDECK_BRIDGE;
    expect(await start()).toEqual({});
    expect(readdirSync(dir)).toEqual([]);
  });
});
