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
