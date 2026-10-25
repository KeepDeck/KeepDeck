/**
 * KeepDeck mail courier — one of the two components of KeepDeck's opencode
 * plugin (index.js beside this file loads both).
 *
 * It is a SEPARATE component on purpose: the reporter's job is to tell
 * KeepDeck about this pane — identity, usage, turn lifecycle — and it asks
 * for nothing. This one's job is the opposite direction, and only this one
 * ever asks.
 *
 * What it exists for: on every other CLI, a teammate's message reaches an
 * agent by being TYPED into its terminal, where it arrives indistinguishable
 * from what the user typed, or by riding a hook's stdout at a turn boundary.
 * opencode needs neither. A plugin here holds the agent's own server client,
 * so a message can be put into the session directly — with a turn when
 * somebody said something, without one when it is only context the pane must
 * hold from now on.
 *
 * The five moments it asks, and why:
 *
 *   session.created     a conversation just started, so the standing brief
 *                       can land before the first word is spoken
 *   chat.message        the user is sending something anyway — anything
 *                       waiting rides along, and nobody pays for a turn
 *   tool.execute.after  a tool call just returned mid-turn: anything waiting
 *                       rides back to the model with its result, which is how
 *                       a working pane is reached at all — the deck holds
 *                       mail for a working pane rather than wake it
 *   session.idle        a turn just ended
 *   <pane>.wake         the deck rang: mail is waiting for an idle pane and
 *                       nothing else was going to happen (see bridge/nudge.rs)
 *
 * Best-effort throughout, like the reporter beside it: a KeepDeck-less
 * environment, a deck that quit, a full disk — none of it may break the
 * user's session, so every failure here ends in silence.
 */
import { randomBytes } from "node:crypto";
import { parentLookupV1 } from "./opencode-v1.js";
import { paneSession } from "./pane-session.js";
import { drained, readBridge } from "./keepdeck-bridge.js";
import { watchDoorbell } from "./doorbell.js";
import { follower } from "./follower.js";
import { answerText, askMail } from "./mail-ask.js";
import { promptSelection } from "./prompt-selection.js";

export async function startCourier(input = {}) {
  const bridge = readBridge();
  if (!bridge) return {}; // not spawned by KeepDeck — stay inert
  const { dir } = bridge;
  const client = input?.client;
  // Without the client there is no way to put anything into the session, and
  // asking would take messages out of the deck's queue to drop them.
  if (!client?.session?.promptAsync) return {};

  /**
   * The pane's conversation, and whether its turn is running — ONE object,
   * shared with the reporter beside this file.
   *
   * Both of those used to be kept here as well, derived from the same events
   * by a different path, and the two answers had already drifted apart: this
   * side cleared what it knew of a conversation's ancestry where the reporter
   * preserved it. Two answers to "is this the pane's conversation" means mail
   * delivered into a session whose turns the deck is not watching — which the
   * comment below `adoptRoot` records as having happened.
   *
   * opencode mints the root lazily: a pane nobody has spoken to yet has none,
   * which is why `viaTui` below exists at all.
   */
  const pane = paneSession(parentLookupV1(client));

  /** Ask the deck what is waiting (mail-ask.js). */
  const ask = askMail(bridge);

  const textPart = (text, synthetic) => ({
    type: "text",
    text,
    ...(synthetic ? { synthetic: true } : {}),
  });

  /**
   * A part for a message opencode is already building, as opencode builds
   * its own: `chat.message` runs after the server has given every part its
   * `id`, `sessionID` and `messageID`, and saving one without them fails the
   * whole prompt (1.16.0 on — a durable event needs the session). Its id
   * sorts after every part already in `parts`, because opencode reads a
   * message's parts back ordered by id.
   */
  const messagePart = (text, synthetic, message, parts) => ({
    id: partIDAfter(parts),
    sessionID: message.sessionID,
    messageID: message.id,
    ...textPart(text, synthetic),
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
  const viaSession = async (answer, sessionID, chosen) => {
    // Both calls run as the user's own last prompt did — read before the
    // context lands, or the newest message would be ours (prompt-selection.js).
    // A session the courier just made has no prompt of the user's yet: its
    // selection comes from the one they left, `chosen`.
    const selection = chosen ?? (await promptSelection(client, sessionID));
    let delivered = true;
    if (typeof answer.context === "string" && answer.context) {
      delivered =
        ok(
          await client.session.promptAsync({
            path: { id: sessionID },
            body: { ...selection, noReply: true, parts: [textPart(answer.context, true)] },
          }),
        ) && delivered;
    }
    if (typeof answer.prompt === "string" && answer.prompt) {
      delivered =
        ok(
          await client.session.promptAsync({
            path: { id: sessionID },
            body: { ...selection, parts: [textPart(answer.prompt, false)] },
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
    const text = answerText(answer);
    if (!text) return false;
    if (!ok(await client.tui.appendPrompt({ body: { text } }))) return false;
    return ok(await client.tui.submitPrompt());
  };

  /**
   * Ask, then deliver whatever came back — into the session the pane is.
   *
   * A session delivery that did not work falls through to the TUI rather than
   * ending here. The deck books a message the moment it hands it over, so
   * anything dropped at this point is dropped for good — a visible delivery
   * the user can see is worth more than a tidy failure nobody hears about.
   */
  const deliver = async () => {
    // The target is fixed BEFORE the ask: the pane may rebind while the
    // answer is in flight, and what the deck was told is where it lands. An
    // unbound pane is reached through the TUI's own prompt, which is the main
    // agent's by construction. A bound one is the root this pane adopted —
    // and an adoption made while the client could not classify it is
    // "unknown", which the deck answers with nothing until it can.
    const root = pane.bound ? pane.root : null;
    const target = root ? await pane.classify(root) : "root";
    const answer = await ask(target);
    if (!answer) return;
    try {
      if (root && (await viaSession(answer, root))) return;
      await viaTui(answer);
    } catch {
      // Best-effort to the end: the user's session must survive anything
      // this file gets wrong.
    }
  };

  /**
   * Whether the pane's conversation is what the TUI shows (foreground.js,
   * task-435) — mail goes nowhere else. Unknown — no observer for this
   * process — means as before there was one. A subagent's view is its
   * conversation's; one not yet known to be is held, not guessed.
   */
  const visible = (screen) =>
    screen.kind === "unknown" ||
    (screen.kind === "session" &&
      pane.bound &&
      pane.rootOf(screen.sessionID) === pane.root);

  /**
   * Collect, if the session on screen is the pane's.
   *
   * Another session on screen: the follower moves the pane there and calls
   * again (follower.js) — the courier never moves the pane itself. Nothing
   * fresh on screen (a stalled TUI, a plugin's screen): held. The home screen
   * after the user LEFT a conversation: a session is made for the mail
   * (`viaHome`) — but only when the deck RANG (`rung`), which it does only
   * for mail that waits: nothing tells otherwise whether any does, and every
   * `/new` would leave an empty session behind. Before any leaving the home
   * screen is opencode's own start, or the native fork's, and the pane is
   * reached as it always was.
   */
  const collect = async ({ rung = false } = {}) => {
    const screen = follower().screen();
    if (screen.kind !== "home") homeFailed = false;
    if (visible(screen)) return deliver();
    if (screen.kind !== "home") return;
    if (pane.left === undefined) return pane.bound ? undefined : deliver();
    if (rung) return viaHome();
  };

  /**
   * Mail for a pane the user left for the home screen (`/new`): what the user
   * would do — a session, shown, then the words — and the user sees it.
   *
   * The ORDER is what makes it safe (design §6.1). The session is made and
   * shown first; only once the TUI shows it, and its binding has reached the
   * deck, is the mail asked for — so a session the TUI never showed costs
   * nothing but an empty session, and the deck hands the brief over WITH the
   * mail rather than after it.
   *
   * The user may start a conversation of their own meanwhile — a root
   * session the courier did not make. Theirs is the one on screen; this one
   * stops (`theirs`). And after a session the TUI did not show, nothing is
   * tried again until the screen changes: the deck re-rings every 45 s, and
   * each ring would make another empty session.
   */
  let homeFailed = false;
  let theirs = false;
  const ours = new Set();
  /** Root sessions that appeared while `session.create` was in flight —
   * opencode announces the new session BEFORE the call returns (measured
   * live, task-444), so which of them is ours is known only after. */
  let creating = null;
  const SHOW_WAIT_MS = 3_000;
  const viaHome = async () => {
    if (homeFailed) return;
    const chosen = await promptSelection(client, pane.left);
    theirs = false;
    creating = [];
    let made;
    try {
      made = await client.session.create({ body: {} });
    } finally {
      const appeared = creating;
      creating = null;
      const id = made?.data?.id;
      if (id) ours.add(id);
      if (appeared.some((other) => other !== id)) theirs = true;
    }
    const id = made?.data?.id;
    if (!ok(made) || !id) return;
    if (theirs || follower().screen().kind !== "home") return;
    await client.tui.publish({
      body: { type: "tui.session.select", properties: { sessionID: id } },
    });
    // Shown, and bound: the reporter takes the new session from its own
    // `session.created`.
    const shown = () => {
      const screen = follower().screen();
      return screen.kind === "session" && screen.sessionID === id && pane.root === id;
    };
    for (let waited = 0; !shown() && waited < SHOW_WAIT_MS; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!shown() || theirs) {
      homeFailed = true;
      return;
    }
    await drained();
    const answer = await ask(await pane.classify(id));
    if (!answer) return;
    try {
      await viaSession(answer, id, chosen);
    } catch {
      // Best-effort, as everywhere here.
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
   * binds on the first completed message instead. Without this, the pane
   * stayed unbound for its whole life: `session.idle` returned early, so
   * nothing was ever collected at a turn boundary, and every doorbell fell
   * through to the TUI submit.
   *
   * The parent check is what keeps it honest — the task tool creates child
   * sessions in this same process, and a child's events can be the first this
   * courier sees; adopting one would bind the pane to a leaf that ends. That
   * check lives in the shared pane session, so the two components cannot answer
   * it differently — and now cannot hold different answers either.
   */
  const adoptRoot = async (sessionID) => {
    if (!sessionID || pane.bound) return;
    // A child's own session is not the pane's, but its ROOT is — and the ask
    // that classified it already paid for that answer. Walking up rather than
    // giving up is what makes this agree with the reporter beside it, which
    // binds the pane to the same root from the same evidence. Declining left
    // the courier bound to nothing on exactly the case it exists for: a pane
    // resumed mid-task, where a subagent's events come first.
    //
    // `unknown` — the client could not say — adopts, for the reason the
    // shared session gives: a pane bound to nothing is unreachable, and the
    // doorbell is the only other way in.
    const kind = await pane.classify(sessionID);
    // The binding itself refuses a second answer, and the reason survives the
    // move: this ran its guard before an await, `chat.message` calls it
    // outside the delivery queue's serialization, and so two events can both
    // find the pane unbound. The SLOWER one — an unrelated subagent, whose
    // chain takes an extra hop — landed last and won, rebinding the pane to
    // somebody else's conversation for the life of the process.
    pane.bindFromChain(
      kind === "child" ? pane.rootOf(sessionID) : sessionID,
      pane.chain(sessionID),
    );
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
          pane.note(created.id, created.parentID);
          return;
        }
        // A new root is a new generation — nothing from the old conversation
        // rolls up to it, and its child ids answer about a session that ended.
        // Refused when it is already the current one: the reporter beside this
        // file sees the same event and says the same thing.
        pane.newGeneration(created.id);
        // One `viaHome` made is its own to deliver into, once it is shown —
        // and it may never be.
        if (ours.has(created.id)) return;
        // A conversation just began — the standing brief belongs in it before
        // the first word, not after whatever the user says next. Delivered
        // to it whatever the screen file says yet: it lags the TUI by a poll,
        // and a root session appearing is the TUI's own — on screen.
        await deliver();
        return;
      }
      case "session.status": {
        const status =
          typeof props.status === "object" ? props.status?.type : props.status;
        if (status !== "busy") return;
        // Adopted for its ROOT alone. Whether a turn is running stopped
        // mattering here when the doorbell started being answered mid-turn:
        // the flag this used to keep had exactly one reader, and it was the
        // refusal that made steering this agent impossible.
        await adoptRoot(props.sessionID);
        return;
      }
      case "session.idle": {
        await adoptRoot(props.sessionID);
        if (props.sessionID !== pane.root) return;
        // Still the cheapest turn a message will ever get, and still where
        // anything that arrived without a ring lands.
        await collect();
        return;
      }
      default:
    }
  };

  /**
   * The deck's doorbell (doorbell.js).
   *
   * The deck rings an IDLE pane. A working one it holds for a boundary, and
   * mid-turn that boundary is `tool.execute.after` below. This used to be
   * written as the pane's mid-turn channel, but the deck stopped ringing a
   * working pane (7e927dfe) and nothing took its place until that hook. A
   * ring is still answered whenever it comes: answering one is never wrong.
   *
   * The words travel through the courier's own ask, framed and attributed.
   * Nothing is typed into the terminal here.
   */
  // Through the queue: `collect` is not re-entrant, and a ring landing while
  // one is in flight has to follow it rather than race it.
  watchDoorbell(dir, () => enqueue(() => collect({ rung: true })));

  // The pane moved to the session the user opened, and the deck knows
  // (follower.js): whatever waits belongs there now.
  follower().onSettled(() => enqueue(() => collect()));

  return {
    // opencode does not await plugin event promises, so the queue is what
    // keeps two collections from overlapping.
    event: ({ event }) => {
      // Told at once, not in turn: a conversation the user started while
      // `viaHome` is under way must stop it before it shows its own.
      const info = event?.type === "session.created" ? event.properties?.info : undefined;
      if (info?.id && !info.parentID && !ours.has(info.id)) {
        if (creating) creating.push(info.id);
        else theirs = true;
      }
      return enqueue(() => onEvent(event));
    },
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
      if (sessionID !== pane.root) return;
      // Behind whatever is already collecting. This hook is not IN the queue
      // — it has to await its own answer to put the parts in place before the
      // request is built — so without this a session.created still in flight
      // could hand its brief over after this message took the task that
      // assumed it. Waiting costs at most what an ask costs, which is what
      // this hook was going to spend anyway.
      await work;
      const message = output?.message;
      if (!message?.id || !message?.sessionID || !Array.isArray(output?.parts)) return;
      // Only once the parts can be placed is anything taken: the deck books a
      // message as delivered the moment it hands it over. The target is the
      // root's classification, as `collect` gives it — a root the client
      // could not classify names nobody, and the deck holds.
      const answer = await ask(await pane.classify(sessionID));
      if (!answer) return;
      if (typeof answer.context === "string" && answer.context) {
        output.parts.push(messagePart(answer.context, true, message, output.parts));
      }
      if (typeof answer.prompt === "string" && answer.prompt) {
        output.parts.push(messagePart(answer.prompt, false, message, output.parts));
      }
    },
    /**
     * A tool call just returned while the turn runs, so anything waiting
     * rides back to the model with its result — the same moment claude's
     * `PostToolBatch` and codex's `PostToolUse` give the deck. opencode
     * hands the result to the model after this hook, in this same turn
     * (packages/opencode/src/session/tools.ts), and every tool passes
     * through it, MCP tools included.
     *
     * The pane's main agent only: a subagent's tool calls run in its own
     * session, and mail landing there would be read by nobody the sender
     * meant.
     */
    "tool.execute.after": async (info, output) => {
      if (!info?.sessionID || info.sessionID !== pane.root) return;
      // A turn running where the user is not looking is not reached.
      if (!visible(follower().screen())) return;
      if (typeof output?.output !== "string") return;
      // Behind whatever is already collecting, as `chat.message` is.
      await work;
      const answer = await ask(await pane.classify(info.sessionID), "mail.ask.tool");
      const text = answer ? answerText(answer) : "";
      if (text) output.output = `${output.output}\n\n${text}`;
    },
  };
}

/**
 * An opencode part id that sorts after every id in `parts`: `prt_`, 12 hex
 * digits of time-and-counter, then 14 random base62 characters — the shape
 * of opencode's own ascending ids (packages/opencode/src/id/id.ts).
 *
 * Above the highest one already there, not merely "now": opencode mints the
 * message's own parts in the same millisecond this runs, with a counter this
 * process cannot see, so a fresh time-and-counter of our own could land
 * below theirs — and opencode reads parts back ordered by id. The hex head
 * alone then decides the order, whatever the random tail.
 */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PART_HEAD = /^prt_([0-9a-f]{12})/;
const PART_HEAD_BITS = 0xffffffffffffn;
function partIDAfter(parts, now = Date.now()) {
  const floor = parts.reduce((highest, part) => {
    const head = PART_HEAD.exec(typeof part?.id === "string" ? part.id : "");
    const value = head ? BigInt(`0x${head[1]}`) : 0n;
    return value > highest ? value : highest;
  }, 0n);
  // opencode keeps the low 48 bits of time × 4096 + counter; compare there.
  const fresh = (BigInt(now) * 0x1000n) & PART_HEAD_BITS;
  const head = (((floor >= fresh ? floor : fresh) + 1n) & PART_HEAD_BITS).toString(16).padStart(12, "0");
  const random = Array.from(randomBytes(14), (byte) => BASE62[byte % 62]).join("");
  return `prt_${head}${random}`;
}
