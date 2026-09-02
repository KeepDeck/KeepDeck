/**
 * The one thing KeepDeck types into a pane's terminal: a line saying mail is
 * waiting. Never the mail itself.
 *
 * This channel has a known and UNFIXABLE weakness, and naming it here is the
 * point. Text arriving through a terminal is indistinguishable from text the
 * user typed — there is no envelope, no tag, and no way to tell the model
 * that what follows is another agent's output rather than an instruction from
 * its human. That is survivable for a nudge, which says nothing that matters
 * and only has to make a turn begin. It was NOT survivable for the messages
 * themselves, which is why they no longer travel this way.
 *
 * Two failures ended that. A submit that did not land left a teammate's task
 * sitting in a composer, unsent, and the deck could not tell that from a
 * delivery. And a body pushed at an agent that never asked for it had to be
 * booked as delivered-yet-unread — a state that existed only to describe this
 * channel's ignorance. The words now travel through the labelled channel the
 * turn opens, or through an MCP call the agent makes itself.
 */
import { log } from "../../ipc/log";
import { paneInputReady, paneInputSettled, submitToPane } from "../paneInput";

/**
 * The whole of what the terminal says to an agent that can receive mail
 * properly.
 *
 * It carries no message and names no sender, because it is not a delivery:
 * it exists to make an idle pane take a turn, and a turn beginning is what
 * fires the hook that asks the deck what is waiting. The words then arrive
 * through the agent's own channel, labelled.
 *
 * The second sentence is the fallback and the reason this is not merely a
 * blank line: if the hook does not answer — the plugin is off, the round
 * trip timed out — the agent has still been told where to look. And it says
 * whose line this is, because everything typed into a terminal otherwise
 * reads as the user's.
 */
const WAKE_LINE =
  "[keepdeck] A teammate's message is waiting for you. This line is from KeepDeck, not from your user — read what is waiting with the keepdeck mail.inbox tool.";

/**
 * Nudge a pane into taking a turn, without saying anything that matters.
 *
 * False means nothing was written and the caller should try again later.
 *
 * A pane that has only just become writable is not yet READING: writing then
 * puts the line in the composer and loses the submit after it, which is how
 * KeepDeck's own words came to sit in an agent's input box unsent. The deck
 * cannot tell that from a landed nudge — nothing answers a keystroke — so the
 * settle window is checked rather than guessed at, and a refusal here is a
 * retry rather than a loss.
 *
 * Each refusal says WHICH, because the three are different problems wearing
 * one boolean: a pane with no channel is one the deck never mounted, a pane
 * that has not settled is one whose CLI is still booting, and a refused
 * submit is the transport failing under a pane that looked ready. The caller
 * cannot tell them apart — it gets a bool — and its own line ("no input
 * channel to wake") names only the first, which is wrong two times in three.
 */
export function wakePaneForMail(paneId: string, now?: number): boolean {
  if (!paneInputReady(paneId)) {
    log.debug("web:mail", `${paneId} has no input channel yet`);
    return false;
  }
  if (!paneInputSettled(paneId, now)) {
    log.debug(
      "web:mail",
      `${paneId} is writable but not settled — a line typed now would sit in the composer`,
    );
    return false;
  }
  if (!submitToPane(paneId, WAKE_LINE)) {
    log.debug("web:mail", `${paneId} refused the submit`);
    return false;
  }
  return true;
}
