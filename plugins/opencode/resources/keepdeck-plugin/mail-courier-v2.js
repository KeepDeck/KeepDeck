// @ts-check
/**
 * KeepDeck mail courier on opencode 2.x — the 2.x twin of mail-courier.js,
 * started by opencode-v2.js. It asks the deck (mail-ask.js) at the same
 * moments, and puts what it gets into the session through 2.x's own domains:
 *
 *   session.created           the brief, before the first word
 *   session.hook("prompt")    the user is sending anyway: ride along in it
 *   tool.hook("execute.after") a tool call returned mid-turn: ride back to
 *                             the model with its result
 *   session.execution.*       a turn ended
 *   the doorbell              mail waits for an idle pane (doorbell.js)
 *
 * The brief is standing context and starts no turn (`session.synthetic`,
 * `resume: false`); somebody's words are worth one (`session.prompt`).
 *
 * A pane with no conversation yet has no session to write into, and 2.x has
 * no prompt box a plugin can type in — its mail waits for the first turn.
 *
 * WHERE mail may go is shared with 1.x (courier-policy.js): only into the
 * conversation the TUI shows, and on the home screen after `/new`, into a
 * session made for it and shown first — through the TUI half, which alone
 * can navigate on 2.x (show-request.js, tui.js).
 */
import { createCourierPolicy } from "./courier-policy.js";
import { watchDoorbell } from "./doorbell.js";
import { follower } from "./follower.js";
import { answerText, askMail } from "./mail-ask.js";
import { requestShow } from "./show-request.js";

/** @typedef {{ dir: string, pane: string, token: string, url: string }} Bridge */
/** @typedef {{ root: string | undefined, left: string | undefined, bound: boolean, classify: (id: string) => Promise<"root" | "child" | "unknown">, rootOf: (id: string) => string, chain: (id: string) => Array<[string, string]>, note: (child: string, parent: string) => void, newGeneration: (id: string) => boolean, bindFromChain: (id: string, keep?: Array<[string, string]>) => boolean, concernsPane: (id: string) => boolean, detach: () => boolean }} Pane */
/** @typedef {{ agent?: unknown, model?: unknown }} Selection */
/** @typedef {{ content?: unknown, output?: unknown }} ToolResult */
/** @typedef {{ sessionID?: string, parentID?: string, model?: { id?: string, providerID?: string }, tokens?: { input?: number, output?: number, reasoning?: number, cache?: { read?: number, write?: number } }, cost?: number, prompt?: { text?: string }, metadata?: Record<string, unknown>, status?: string, result?: ToolResult }} EventData */
/** @typedef {{ type?: string, data?: EventData }} BusEvent */
/** @typedef {{ model: { list: () => Promise<{ data?: Array<{ providerID: string, id: string, limit?: { context?: number } }> }> }, session: { get: (query: { sessionID: string }) => Promise<{ agent?: unknown, model?: unknown } | undefined>, create: (query: Record<string, unknown>) => Promise<{ id?: string } | undefined>, synthetic: (input: { sessionID: string, text: string, resume: boolean }) => Promise<unknown>, prompt: (input: { sessionID: string, text: string, metadata: Record<string, unknown> }) => Promise<unknown>, hook: (name: string, handler: (event: EventData) => Promise<void>) => Promise<unknown> }, tool: { hook: (name: string, handler: (event: EventData) => Promise<void>) => Promise<unknown> } }} Context */

/** What marks a prompt this courier sent, for the prompt hook to pass by. */
const MAIL_METADATA = { keepdeck: "mail" };

const TURN_ENDS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

/** @param {{ context: Context, bridge: Bridge, pane: Pane, resumed?: string }} input */
export async function startCourierV2({ context, bridge, pane, resumed }) {
  const ask = askMail(bridge);

  /** Put an answer into the pane's conversation. Our own prompt is marked,
   * so the prompt hook below — which opencode runs for it too — passes it by. */
  /** @param {{ context?: string, prompt?: string } | null} answer @param {string} sessionID */
  const deliver = async (answer, sessionID) => {
    if (!answer) return;
    if (typeof answer.context === "string" && answer.context) {
      await context.session.synthetic({ sessionID, text: answer.context, resume: false });
    }
    if (typeof answer.prompt === "string" && answer.prompt) {
      await context.session.prompt({ sessionID, text: answer.prompt, metadata: MAIL_METADATA });
    }
  };

  /**
   * The asks, one at a time and in order: a brief must be taken before the
   * message that assumes it. ONLY the asks — delivery runs outside this
   * chain, because `session.prompt` runs this courier's own prompt hook,
   * which waits on the chain: a delivery inside it waited on itself, and
   * every later prompt on the pane hung behind it (2.1.2, task-375).
   */
  /** @type {Promise<unknown>} */
  let asks = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} job
   * @returns {Promise<T>}
   */
  const inTurn = (job) => {
    const turn = asks.then(job);
    asks = turn.catch(() => {});
    return turn;
  };

  /** Deliveries, in the order their asks were answered — a chain of its own
   * that no hook waits on. */
  /** @type {Promise<unknown>} */
  let deliveries = Promise.resolve();

  /** Ask, then deliver — into the conversation the pane has, or the one
   * that has just begun (`into`).
   * @param {string} [into]
   */
  const collect = async (into) => {
    const root = into ?? (pane.bound ? pane.root : null);
    if (!root) return;
    // Fixed BEFORE the ask: what the deck was told is where it lands. A
    // conversation that has just begun has no parent by its own creation.
    const answer = await inTurn(async () => {
      const target = into ? "root" : await pane.classify(root);
      // The session the pane was resumed into is bound before opencode was
      // ever asked about it (opencode-v2.js). If opencode cannot find it —
      // deleted since it was recorded — the mail would be taken and written
      // nowhere. Held instead: `-s` names it, and the user's first prompt
      // creates it.
      if (target === "unknown" && root === resumed) return null;
      return ask(target);
    }).catch(() => null);
    if (!answer) return;
    // Best-effort: the user's session must survive anything this gets wrong.
    deliveries = deliveries.then(() => deliver(answer, root)).catch(() => {});
    await deliveries;
  };

  /** Where mail may go (courier-policy.js); what is 2.x here is how. */
  const policy = createCourierPolicy({
    pane,
    screen: () => follower().screen(),
    // In turn with the prompt hook's asks, as every ask here is.
    ask: (target) => inTurn(() => ask(target)),
    deliverToPane: () => collect(),
    adapter: {
      selectionOf: async (sessionID) => {
        if (!sessionID) return undefined;
        const found = await context.session.get({ sessionID });
        return { agent: found?.agent, model: found?.model };
      },
      createSession: async (selection) => {
        const made = await context.session.create({
          ...(selection?.agent ? { agent: selection.agent } : {}),
          ...(selection?.model ? { model: selection.model } : {}),
        });
        return made?.id ?? null;
      },
      show: async (sessionID) => requestShow(bridge.dir, sessionID),
      // Our own prompt is marked, so it does not wait on the asks chain.
      deliver: (answer, sessionID) => deliver(answer, sessionID),
    },
  });

  /** One collection at a time: the policy's home-screen delivery is not
   * re-entrant, and a ring landing mid-collection follows it. */
  /** @type {Promise<unknown>} */
  let work = Promise.resolve();
  /** @param {() => Promise<unknown>} job */
  const enqueue = (job) => {
    work = work.then(job).catch(() => {});
    return work;
  };

  // The courier READS the pane's conversation and never moves it: the
  // reporter does, in the order of its own events. Moving it here, ahead of
  // the reporter's queue, made the reporter read its previous events against
  // the new conversation and drop the old one's ending, leaving the pane
  // "working" (review of task-375). A conversation that has just begun gets
  // its brief by its own id — it is the user's, and on screen — unless the
  // policy made it for mail, which is delivered once it is shown.
  /** @param {BusEvent} event */
  const onEvent = (event) => {
    const type = event?.type;
    const data = event?.data ?? {};
    if (type === "session.created" && data.sessionID && !data.parentID) {
      // Told at once, not in turn: one the user started while a session for
      // mail is being made must stop that before it shows its own.
      policy.rootAppeared(data.sessionID);
      if (!policy.ours(data.sessionID)) void collect(data.sessionID);
      return;
    }
    if (typeof type === "string" && TURN_ENDS.has(type) && data.sessionID && data.sessionID === pane.root) {
      void enqueue(() => policy.collect());
    }
  };

  const stopDoorbell = watchDoorbell(bridge.dir, () => void enqueue(() => policy.collect({ rung: true })));

  // The pane moved to the session the user opened, or was left, and the deck
  // knows (follower.js): whatever waits belongs where the user is now.
  follower().onSettled(() => void enqueue(() => policy.collect()));

  // The user is sending something: anything waiting rides in the same
  // message, and nobody pays for a turn. The prompt is opencode's to send
  // after this hook, so its text is what changes.
  await context.session.hook("prompt", async (event) => {
    if (!event?.sessionID || event.sessionID !== pane.root) return;
    const sessionID = event.sessionID;
    if (typeof event.prompt?.text !== "string") return;
    if (event.metadata?.keepdeck === MAIL_METADATA.keepdeck) return;
    const answer = await inTurn(async () => ask(await pane.classify(sessionID))).catch(
      () => null,
    );
    const text = answer ? answerText(answer) : "";
    if (text) event.prompt.text = `${event.prompt.text}\n\n${text}`;
  });

  // A tool call returned while the turn runs: anything waiting rides back to
  // the model with its result, in this same turn — the boundary the deck
  // holds a working pane's mail for. opencode reads `result.content` back
  // after this hook (packages/core/src/tool.ts at v2.1.2).
  await context.tool.hook("execute.after", async (event) => {
    if (!event?.sessionID || event.sessionID !== pane.root) return;
    const sessionID = event.sessionID;
    // A turn running where the user is not looking — a tab left behind — is
    // not reached.
    if (!policy.visible()) return;
    if (event.status !== "completed" || !event.result) return;
    const answer = await inTurn(async () =>
      ask(await pane.classify(sessionID), "mail.ask.tool"),
    ).catch(() => null);
    const text = answer ? answerText(answer) : "";
    if (!text) return;
    event.result = {
      ...event.result,
      content: [...contentOf(event.result), { type: "text", text }],
    };
  });

  return { onEvent, stop: stopDoorbell };
}

/**
 * A tool result's content as the model would get it — opencode's own
 * reading (normalizeContent, packages/core/src/tool/runtime.ts): a string is
 * one text part, an empty list falls back to the output, stringified.
 */
/** @param {ToolResult} result @returns {unknown[]} */
function contentOf(result) {
  const { content, output } = result;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content) && content.length > 0) return content;
  if (output === undefined) return [];
  return [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) ?? "" }];
}
