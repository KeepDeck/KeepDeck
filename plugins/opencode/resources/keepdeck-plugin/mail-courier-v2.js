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
 */
import { watchDoorbell } from "./doorbell.js";
import { answerText, askMail } from "./mail-ask.js";

/** What marks a prompt this courier sent, for the prompt hook to pass by. */
const MAIL_METADATA = { keepdeck: "mail" };

const TURN_ENDS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

export async function startCourierV2({ context, bridge, pane }) {
  const ask = askMail(bridge);

  /** Put an answer into the pane's conversation. Our own prompt is marked,
   * so the prompt hook below — which opencode runs for it too — passes it by. */
  const deliver = async (answer, sessionID) => {
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
  let asks = Promise.resolve();
  const inTurn = (job) => {
    const turn = asks.then(job);
    asks = turn.catch(() => {});
    return turn;
  };

  /** Deliveries, in the order their asks were answered — a chain of its own
   * that no hook waits on. */
  let deliveries = Promise.resolve();

  /** Ask, then deliver — only into a conversation the pane has, or the one
   * that has just begun (`into`). */
  const collect = async (into) => {
    const root = into ?? (pane.bound ? pane.root : null);
    if (!root) return;
    // Fixed BEFORE the ask: what the deck was told is where it lands. A
    // conversation that has just begun has no parent by its own creation.
    const answer = await inTurn(async () => ask(into ? "root" : await pane.classify(root))).catch(
      () => null,
    );
    if (!answer) return;
    // Best-effort: the user's session must survive anything this gets wrong.
    deliveries = deliveries.then(() => deliver(answer, root)).catch(() => {});
    await deliveries;
  };

  // The courier READS the pane's conversation and never moves it: the
  // reporter does, in the order of its own events. Moving it here, ahead of
  // the reporter's queue, made the reporter read its previous events against
  // the new conversation and drop the old one's ending, leaving the pane
  // "working" (review of task-375). A conversation that has just begun gets
  // its brief by its own id.
  const onEvent = (event) => {
    const type = event?.type;
    const data = event?.data ?? {};
    if (type === "session.created" && data.sessionID && !data.parentID) {
      void collect(data.sessionID);
      return;
    }
    if (TURN_ENDS.has(type) && data.sessionID && data.sessionID === pane.root) {
      void collect();
    }
  };

  watchDoorbell(bridge.dir, () => void collect());

  // The user is sending something: anything waiting rides in the same
  // message, and nobody pays for a turn. The prompt is opencode's to send
  // after this hook, so its text is what changes.
  await context.session.hook("prompt", async (event) => {
    if (!event?.sessionID || event.sessionID !== pane.root) return;
    if (typeof event.prompt?.text !== "string") return;
    if (event.metadata?.keepdeck === MAIL_METADATA.keepdeck) return;
    const answer = await inTurn(async () => ask(await pane.classify(event.sessionID))).catch(
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
    if (event.status !== "completed" || !event.result) return;
    const answer = await inTurn(async () =>
      ask(await pane.classify(event.sessionID), "mail.ask.tool"),
    ).catch(() => null);
    const text = answer ? answerText(answer) : "";
    if (!text) return;
    event.result = {
      ...event.result,
      content: [...contentOf(event.result), { type: "text", text }],
    };
  });

  return { onEvent };
}

/**
 * A tool result's content as the model would get it — opencode's own
 * reading (normalizeContent, packages/core/src/tool/runtime.ts): a string is
 * one text part, an empty list falls back to the output, stringified.
 */
function contentOf(result) {
  const { content, output } = result;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content) && content.length > 0) return content;
  if (output === undefined) return [];
  return [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }];
}
