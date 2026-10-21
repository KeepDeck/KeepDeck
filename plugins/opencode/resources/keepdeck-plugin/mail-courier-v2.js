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

const TURN_ENDS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

export async function startCourierV2({ context, bridge, pane }) {
  const ask = askMail(bridge);

  /** Put an answer into the pane's conversation. */
  const deliver = async (answer, sessionID) => {
    if (typeof answer.context === "string" && answer.context) {
      await context.session.synthetic({ sessionID, text: answer.context, resume: false });
    }
    if (typeof answer.prompt === "string" && answer.prompt) {
      await context.session.prompt({ sessionID, text: answer.prompt });
    }
  };

  /** Ask, then deliver — only into a conversation the pane has. */
  const collect = async () => {
    const root = pane.bound ? pane.root : null;
    if (!root) return;
    // Fixed BEFORE the ask: what the deck was told is where it lands.
    const answer = await ask(await pane.classify(root));
    if (!answer) return;
    try {
      await deliver(answer, root);
    } catch {
      // Best-effort: the user's session must survive anything this gets wrong.
    }
  };

  /** One collection at a time, in order: a brief must not land after the
   * message that assumed it. */
  let work = Promise.resolve();
  const enqueue = (job) => {
    work = work.then(job).catch(() => {});
    return work;
  };

  const onEvent = (event) => {
    const type = event?.type;
    const data = event?.data ?? {};
    if (type === "session.created" && !data.parentID) {
      pane.newGeneration(data.sessionID);
      enqueue(collect);
      return;
    }
    if (TURN_ENDS.has(type) && data.sessionID && data.sessionID === pane.root) {
      enqueue(collect);
    }
  };

  watchDoorbell(bridge.dir, () => enqueue(collect));

  // The user is sending something: anything waiting rides in the same
  // message, and nobody pays for a turn. The prompt is opencode's to send
  // after this hook, so its text is what changes.
  await context.session.hook("prompt", async (event) => {
    if (!event?.sessionID || event.sessionID !== pane.root) return;
    if (typeof event.prompt?.text !== "string") return;
    await work;
    const answer = await ask(await pane.classify(event.sessionID));
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
    await work;
    const answer = await ask(await pane.classify(event.sessionID), "mail.ask.tool");
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
