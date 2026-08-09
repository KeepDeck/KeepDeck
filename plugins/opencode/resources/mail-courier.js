/**
 * KeepDeck mail courier — an opencode plugin.
 *
 * Injected PER SPAWN beside the session reporter, through the same
 * `OPENCODE_CONFIG_CONTENT.plugin` array (which is additive; nothing is
 * installed on the user's side). It is a SEPARATE plugin on purpose: the
 * reporter's job is to tell KeepDeck about this pane — identity, usage, turn
 * lifecycle — and it asks for nothing. This one's job is the opposite
 * direction, and only this one ever asks.
 *
 * What it exists for: on every other CLI, a teammate's message reaches an
 * agent by being TYPED into its terminal, where it arrives indistinguishable
 * from what the user typed, or by riding a hook's stdout at a turn boundary.
 * opencode needs neither. A plugin here holds the agent's own server client,
 * so a message can be put into the session directly — with a turn when
 * somebody said something, without one when it is only context the pane must
 * hold from now on.
 *
 * The four moments it asks, and why:
 *
 *   session.created  a conversation just started, so the standing brief can
 *                    land before the first word is spoken
 *   chat.message     the user is sending something anyway — anything waiting
 *                    rides along, and nobody pays for a turn
 *   session.idle     a turn just ended, which is the boundary the deck holds
 *                    messages for
 *   <pane>.wake      the deck rang: mail is waiting and nothing else was
 *                    going to happen (see bridge/nudge.rs)
 *
 * Best-effort throughout, like the reporter beside it: a KeepDeck-less
 * environment, a deck that quit, a full disk — none of it may break the
 * user's session, so every failure here ends in silence.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Which process is reporting.
 *
 * The same answer the session reporter gives, for the same reason and by the
 * same rule: the deck pins a pane's identity to ONE process, because the
 * bridge secret is inherited by the pane's whole tree. This runs inside the
 * agent, so the agent's pid is that name — and being a second plugin in the
 * SAME process, it is the same name the reporter uses. A nested opencode gets
 * its own and is refused.
 */
const REPORTER = String(process.pid);

/** The answer shape this courier understands. The deck stamps it; a shape
 * change bumps it, and an answer from a version this cannot read is dropped
 * rather than half-applied — a pane spawned before an update is still running
 * this exact file. */
const REPLY_VERSION = 1;

/** How long to wait for the deck's answer: 40 × 50ms = 2s, the same window
 * the shell hooks poll, and inside the 2.5s the deck waits before deciding
 * nobody came for it. Longer would hold up `chat.message`, which is the one
 * place this sits in front of the user's own keystroke. */
const ASK_TRIES = 40;
const ASK_SLEEP_MS = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async (input = {}) => {
  let bridge;
  try {
    bridge = JSON.parse(process.env.KEEPDECK_BRIDGE ?? "");
  } catch {
    return {}; // not spawned by KeepDeck — stay inert
  }
  const { dir, pane, token } = bridge ?? {};
  if (!dir || !pane || !token) return {};
  const client = input?.client;
  // Without the client there is no way to put anything into the session, and
  // asking would take messages out of the deck's queue to drop them.
  if (!client?.session?.promptAsync) return {};

  /** The pane's ROOT session, once one exists. opencode mints it lazily — a
   * pane nobody has spoken to yet has none, which is why `viaTui` below
   * exists at all. */
  let activeRoot;
  /** Child sessions (the task/subagent tool creates them in this same
   * process). Their turns are not the pane's turns and their ids are not the
   * pane's identity. */
  const children = new Set();
  /** Whether the pane's own turn is running. Only used to decide whether a
   * doorbell may be answered right now: mid-turn it may not, and the
   * `session.idle` at the end of that turn collects anyway. */
  let busy = false;

  /** Atomically drop one bridge envelope into the inbox — tmp + rename, so
   * the deck's watcher never sees a torn file. */
  const publish = (envelope) => {
    try {
      const base = join(dir, `${envelope.type}-${randomUUID()}`);
      writeFileSync(`${base}.tmp`, JSON.stringify(envelope));
      renameSync(`${base}.tmp`, `${base}.json`);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Ask the deck what is waiting, and wait for the answer.
   *
   * The envelope is an `agent.status` one because that is the lane the deck
   * answers questions on — one round trip, one handler, so a pane can never
   * be told two things about itself in an order nobody chose. The event it
   * carries is ours (`mail.ask`) and the status normalizer ignores it: this
   * envelope reports nothing, it only asks.
   *
   * The reply file is read AND removed, exactly as the shell hooks do it.
   * That removal is the only evidence the deck has that its answer was
   * collected — a file still sitting there means the messages in it were
   * handed over and lost, and it puts them back.
   */
  const ask = async () => {
    const correlation = randomUUID();
    const sent = publish({
      v: 1,
      type: "agent.status",
      paneId: pane,
      token,
      payload: {
        agent: "opencode",
        reporter: REPORTER,
        reply: correlation,
        event: { type: "mail.ask" },
      },
    });
    if (!sent) return null;
    const path = join(dir, `${correlation}.reply`);
    for (let tries = ASK_TRIES; tries > 0; tries--) {
      let body;
      try {
        if (existsSync(path)) {
          body = readFileSync(path, "utf8");
          rmSync(path, { force: true });
        }
      } catch {
        return null;
      }
      if (body === undefined) {
        await sleep(ASK_SLEEP_MS);
        continue;
      }
      // An EMPTY answer is the common one and a real one: nothing waiting.
      if (body === "") return null;
      try {
        const answer = JSON.parse(body);
        return answer?.v === REPLY_VERSION ? answer : null;
      } catch {
        return null;
      }
    }
    return null; // the deck never answered — the message stays in its queue
  };

  const textPart = (text, synthetic) => ({
    type: "text",
    text,
    ...(synthetic ? { synthetic: true } : {}),
  });

  /**
   * Whether a client call actually worked.
   *
   * The generated client does NOT throw on a failed request — it RESOLVES
   * with `{error}` — so an await inside a try/catch reports success for a
   * rejected call. That is not a hypothetical: every delivery this courier
   * made in its first version was silently dropped that way, because the
   * arguments were built in the wrong shape and nothing ever said so.
   */
  const ok = (result) => !result?.error;

  /**
   * Put an answer into the pane's live session.
   *
   * The two halves land differently because they ARE different:
   *
   * - `context` is the standing brief. `noReply` stores it without running
   *   the model (opencode's own word for this — it injects project moves the
   *   same way), and `synthetic` keeps a wall of setup text out of the
   *   transcript the user is reading. Nothing was said to anybody, so nothing
   *   should start.
   * - `prompt` is somebody's words, and they are worth a turn: a message
   *   that sits unread until the user next happens to type is not delivered
   *   in any sense that matters. It is NOT synthetic — the person watching
   *   this pane should see what arrived and why their agent just moved.
   */
  const viaSession = async (answer) => {
    let delivered = true;
    if (typeof answer.context === "string" && answer.context) {
      delivered =
        ok(
          await client.session.promptAsync({
            path: { id: activeRoot },
            body: { noReply: true, parts: [textPart(answer.context, true)] },
          }),
        ) && delivered;
    }
    if (typeof answer.prompt === "string" && answer.prompt) {
      delivered =
        ok(
          await client.session.promptAsync({
            path: { id: activeRoot },
            body: { parts: [textPart(answer.prompt, false)] },
          }),
        ) && delivered;
    }
    return delivered;
  };

  /**
   * The one path for a pane that has no session yet.
   *
   * opencode mints a session at the first message, so a pane nobody has
   * spoken to has nothing to inject into — and a session created here would
   * not be the one the TUI is showing. Submitting through opencode's own
   * prompt is what a keystroke would do, minus the keystroke: no PTY, no
   * bracketed paste, no text left sitting in a composer because the submit
   * went missing.
   *
   * Both halves go together — it is all landing in the same first turn of
   * the same fresh conversation, and dropping the brief to keep this tidy
   * would lose it for good: the deck has already handed it over.
   */
  const viaTui = async (answer) => {
    if (!client?.tui?.appendPrompt || !client?.tui?.submitPrompt) return false;
    const text = [answer.context, answer.prompt]
      .filter((half) => typeof half === "string" && half)
      .join("\n\n");
    if (!text) return false;
    if (!ok(await client.tui.appendPrompt({ body: { text } }))) return false;
    return ok(await client.tui.submitPrompt());
  };

  /**
   * Ask, then deliver whatever came back.
   *
   * A session delivery that did not work falls through to the TUI rather than
   * ending here. The deck books a message the moment it hands it over, so
   * anything dropped at this point is dropped for good — a visible delivery
   * the user can see is worth more than a tidy failure nobody hears about.
   */
  const collect = async () => {
    const answer = await ask();
    if (!answer) return;
    try {
      if (activeRoot && (await viaSession(answer))) return;
      await viaTui(answer);
    } catch {
      // Best-effort to the end: the user's session must survive anything
      // this file gets wrong.
    }
  };

  /** One at a time. Two collections in flight would race for the same queue
   * and could inject a brief after the message that assumed it. */
  let work = Promise.resolve();
  const enqueue = (job) => {
    work = work.then(job).catch(() => {});
    return work;
  };

  /**
   * Take `sessionID` as this pane's conversation, if it is one.
   *
   * `session.created` is not enough on its own. A RESUMED pane (`-s <id>`,
   * which is how every pane comes back after a restart) never fires a root
   * one — the session reporter beside this file learned that the hard way and
   * binds on the first completed message instead. Without this, activeRoot
   * stayed empty for the life of such a pane: `session.idle` returned early,
   * so nothing was ever collected at a turn boundary, and every doorbell fell
   * through to the TUI submit.
   *
   * The parent check is what keeps it honest. The task tool creates child
   * sessions in this same process, and a child's events can be the first this
   * courier sees; adopting one would bind the pane to a leaf that ends. Asked
   * rather than guessed — and when the client cannot answer, adopting is
   * still better than never binding at all, because the doorbell is the only
   * other way in.
   */
  const adoptRoot = async (sessionID) => {
    if (!sessionID || activeRoot || children.has(sessionID)) return;
    if (client?.session?.get) {
      try {
        const found = await client.session.get({ path: { id: sessionID } });
        const info = found?.data;
        if (info?.parentID) {
          children.add(sessionID);
          return;
        }
      } catch {
        // Fall through and adopt: an unanswerable question is not a reason
        // to leave the pane unreachable.
      }
    }
    activeRoot = sessionID;
  };

  const onEvent = async (event) => {
    const props = event?.properties ?? {};
    switch (event?.type) {
      case "session.created": {
        const created = props.info;
        if (!created?.id) return;
        // Root sessions only: the task/subagent tool creates children in this
        // same process, and binding to one would follow a transient leaf.
        if (created.parentID) {
          children.add(created.id);
          return;
        }
        activeRoot = created.id;
        // A conversation just began — the standing brief belongs in it before
        // the first word, not after whatever the user says next.
        await collect();
        return;
      }
      case "session.status": {
        const status =
          typeof props.status === "object" ? props.status?.type : props.status;
        if (status !== "busy") return;
        await adoptRoot(props.sessionID);
        if (props.sessionID === activeRoot) busy = true;
        return;
      }
      case "session.idle": {
        await adoptRoot(props.sessionID);
        if (props.sessionID !== activeRoot) return;
        busy = false;
        // The boundary the deck holds messages for: anything that arrived
        // mid-turn lands here, and this is the cheapest turn it will ever get.
        await collect();
        return;
      }
      default:
    }
  };

  /**
   * The deck's doorbell (bridge/nudge.rs): mail is waiting and no turn
   * boundary was coming on its own. The file carries nothing — everything
   * about the mail is in the answer to the ask — so taking it down IS
   * reading it.
   *
   * Ignored while a turn is running: injecting mid-turn is not something
   * opencode promises anything about, and the `session.idle` closing that
   * turn collects anyway, moments later.
   */
  const takeDoorbell = () => {
    // `dir` is this pane's OWN inbox, so the doorbell needs no name of its
    // own — there is only ever one pane's worth of traffic in here.
    const path = join(dir, "mail.wake");
    try {
      if (!existsSync(path)) return;
      rmSync(path, { force: true });
    } catch {
      return;
    }
    if (!busy) enqueue(collect);
  };

  try {
    // A ring that landed before this process was watching — a pane still
    // booting when the deck rang — is still on disk. Nobody re-sends it.
    takeDoorbell();
    // Unref'd: a watcher is background work, and it has no business being
    // the last thing keeping an exiting process alive.
    watch(dir, () => takeDoorbell()).unref?.();
  } catch {
    // No watcher: the pane still gets its mail at every turn boundary and
    // every prompt the user sends. Only the idle case is lost.
  }

  return {
    // opencode does not await plugin event promises, so the queue is what
    // keeps two collections from overlapping.
    event: ({ event }) => enqueue(() => onEvent(event)),
    /**
     * The user is sending something, so anything waiting rides along inside
     * the same request. This is the only delivery that costs nothing at all —
     * no extra turn, no wake — and it is why the hook is awaited: the parts
     * have to be there before the request is built.
     */
    "chat.message": async (info, output) => {
      const sessionID = info?.sessionID;
      // First contact with a lazily-minted session: this fires for the very
      // message that creates it.
      await adoptRoot(sessionID);
      if (sessionID !== activeRoot) return;
      // Behind whatever is already collecting. This hook is not IN the queue
      // — it has to await its own answer to put the parts in place before the
      // request is built — so without this a session.created still in flight
      // could hand its brief over after this message took the task that
      // assumed it. Waiting costs at most what an ask costs, which is what
      // this hook was going to spend anyway.
      await work;
      const answer = await ask();
      if (!answer || !Array.isArray(output?.parts)) return;
      if (typeof answer.context === "string" && answer.context) {
        output.parts.push(textPart(answer.context, true));
      }
      if (typeof answer.prompt === "string" && answer.prompt) {
        output.parts.push(textPart(answer.prompt, false));
      }
    },
  };
};
