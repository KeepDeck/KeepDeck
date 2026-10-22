/**
 * Asking the deck for this pane's mail — the half of the courier both
 * opencode generations share. How the answer is put into the session is each
 * generation's own (mail-courier.js on 1.x, mail-courier-v2.js on 2.x).
 */
import { randomUUID } from "node:crypto";
import { makeEnvelope, sendEnvelope } from "./keepdeck-bridge.js";

/** The answer shape the courier understands. The deck stamps it; a shape
 * change bumps it, and an answer from a version this cannot read is dropped
 * rather than half-applied — a pane spawned before an update is still running
 * this exact file. */
export const REPLY_VERSION = 1;

/**
 * Ask the deck what is waiting, and wait for the answer.
 *
 * The envelope is an `agent.status` one because that is the lane the deck
 * answers questions on — one round trip, one handler, so a pane can never be
 * told two things about itself in an order nobody chose. The event it carries
 * is ours and the status normalizer ignores it: this envelope reports
 * nothing, it only asks.
 *
 * The answer comes back on the same call, so there is no file to poll for and
 * no window in which an answer exists that nobody has come for; the deck
 * learns from the send itself whether anyone was there, and puts the
 * messages back when nobody was.
 */
export const askMail = (bridge) => async (target, type = "mail.ask") => {
  const envelope = makeEnvelope(bridge, "agent.status", {
    reply: randomUUID(),
    // Where the answer will land, as the courier knows it: the deck hands
    // mail only to the pane's MAIN agent, and only this side can say whether
    // the session it is about to write into is the root. An ask naming no
    // target is refused before anything leaves the queue.
    //
    // `type` is the channel (plugins/opencode/src/mail.ts): `mail.ask` at a
    // turn's edges, `mail.ask.tool` after a tool call mid-turn.
    event: { type, target },
  });
  const sent = await sendEnvelope(bridge, envelope);
  // Null covers every ending but an answer with content: nothing was waiting,
  // the deck went quiet, nothing was listening. They differ in diagnosis and
  // not in what this turn does — there is nothing to inject either way, and
  // the queue keeps whatever it kept.
  return sent.answer === null ? null : readAnswer(sent.answer);
};

/** One reading of the deck's answer. An EMPTY one is a real answer and the
 * common one: nothing was waiting. */
function readAnswer(body) {
  if (body === "") return null;
  try {
    const answer = JSON.parse(body);
    return answer?.v === REPLY_VERSION ? answer : null;
  } catch {
    return null;
  }
}

/** The two halves of an answer as one block of text, brief first. */
export const answerText = (answer) =>
  [answer.context, answer.prompt]
    .filter((half) => typeof half === "string" && half)
    .join("\n\n");
