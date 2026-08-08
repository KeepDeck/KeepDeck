/**
 * Mail delivered the only way that works in every CLI today: as a paste into
 * the pane's terminal, exactly how the spawn task is delivered.
 *
 * This channel has a known and UNFIXABLE weakness, and naming it here is the
 * point. Text arriving through a terminal is indistinguishable from text the
 * user typed — there is no envelope, no tag, and no way to tell the model
 * that what follows is another agent's output rather than an instruction
 * from its human. The header below is a CONVENTION: it helps a cooperative
 * model, and it is not a guarantee against an uncooperative one, because the
 * sender's own body could just as easily contain a line that looks like it.
 *
 * The hook channel is what fixes this properly (claude's `additionalContext`,
 * codex's `continuation_fragments`), and it arrives as a second adapter
 * behind the same port. Until then this is the honest floor: it works
 * everywhere, and it promises exactly as much as it can keep.
 */
import type { Mail } from "../../domain/mail";
import {
  paneInputReady,
  paneInputSettled,
  pasteToPane,
  writeRawToPane,
} from "../paneInput";

/**
 * The text one message becomes in a terminal.
 *
 * One header line, then the body verbatim. The header says three things the
 * receiver cannot work out for itself: that this came through KeepDeck, who
 * sent it, and which id a reply should reference. Keeping it to one line is
 * deliberate — it rides in front of every message, and a paragraph of
 * preamble per note would cost more context than the notes are worth.
 */
export function renderMail(mail: Mail): string {
  // Named by ROLE, never by pane title. The receiver replies to whatever it
  // was told the sender was, and only a role is an address — shown a title,
  // an agent sent to the title and was refused. A sender on no team has no
  // address to give, so its title stands in and the reply has to be
  // addressed some other way.
  const origin =
    mail.from.kind === "host"
      ? "from KeepDeck itself"
      : `from ${mail.from.pane.role ?? mail.from.pane.label}, another agent in this deck and not your user`;
  return `[keepdeck mail ${mail.id} — ${mail.kind}, ${origin}; reply with mail.send replyTo="${mail.id}"]\n${mail.body}`;
}

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
 * Same channel and same caveats as a delivery, and the same answer: false
 * means nothing was written and the caller should try again later.
 */
export function wakePaneForMail(paneId: string, now?: number): boolean {
  if (!paneInputReady(paneId) || !paneInputSettled(paneId, now)) return false;
  if (!pasteToPane(paneId, WAKE_LINE)) return false;
  writeRawToPane(paneId, "\r");
  return true;
}

/**
 * Deliver through the pane's terminal. False means the pane has no live
 * input channel right now, which the owner treats as a retry.
 */
export function deliverMailThroughPty(mail: Mail, now?: number): boolean {
  if (!paneInputReady(mail.toPaneId)) return false;
  // A pane that has only just become writable is not yet READING. Pasting
  // then puts the text in the composer and loses the submit after it, which
  // is how a briefing came to sit in an agent's input box unsent — and the
  // deck could not tell that from a delivery, because a paste is answered by
  // nothing at all. Reported as a retry, which is exactly what it is.
  if (!paneInputSettled(mail.toPaneId, now)) return false;
  // The PASTE channel, framed by the renderer, so a body containing its own
  // newlines or a CR arrives whole instead of submitting itself halfway
  // through. That framing is the reason the submit below has to be separate.
  if (!pasteToPane(mail.toPaneId, renderMail(mail))) return false;
  // A raw CR OUTSIDE the paste, for the reason `deliverTask` documents: the
  // whole pasted argument is wrapped in bracketed-paste markers, so a "\r"
  // concatenated onto the text would arrive as pasted content and the
  // message would sit in the composer unsent.
  writeRawToPane(mail.toPaneId, "\r");
  return true;
}
