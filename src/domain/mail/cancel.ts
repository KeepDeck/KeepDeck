/**
 * Taking back a message that was already sent.
 *
 * The kinds live here and the prose lives in the app, the same split
 * `sendRefusal` draws — but the ORDER those kinds are decided in is a rule of
 * its own, and it belongs here because getting it wrong leaks.
 *
 * A refusal is a reading. An agent that hears "that message is not yours"
 * has learned that the id EXISTS, which is a fact about somebody else's
 * traffic; it can then walk the ids until the wording changes and count a
 * conversation it never saw. So "no such message" and "not yours" are ONE
 * answer, and the deck does not say which.
 *
 * The two refusals that stay separate say nothing the sender did not already
 * know: what its own team is called, and where its own message went.
 */

/** Why a cancel was refused, in the order the deck decides them. */
export type CancelRefusal =
  /** Not a message id at all — the caller passed a role, or prose. */
  | { kind: "not-an-id" }
  /**
   * Nothing of yours answers to that id.
   *
   * Deliberately covers three situations at once: the id never existed, it
   * belongs to another sender, and it was yours but the deck has forgotten
   * it. The third is not a design choice so much as a fact — nothing records
   * an evicted id, so "yours but gone" and "never existed" are the same
   * state seen from outside.
   */
  | { kind: "unknown" }
  /** The address named resolves to nobody on the caller's team today. */
  | { kind: "unresolved-address" }
  /** The message is the caller's, but it went to a different pane than the
   * address it named. Its own traffic, so it may be told plainly. */
  | { kind: "went-elsewhere" };

/**
 * What became of a message the deck agreed to look at.
 *
 * Two words for four states on purpose. Whether the recipient has READ it is
 * the recipient's business: a sender that could tell "handed over but not
 * read" from "read" would have a read receipt nobody granted, and could poll
 * for it. Both mean the same thing for what the sender does next — send a
 * correction — so both say the same thing.
 */
export type CancelOutcome =
  /** Taken back. It is not in any live process's context and will not be
   * delivered to one. */
  | { kind: "cancelled" }
  /** It is in the context of a process that is still running. */
  | { kind: "too-late" };

/**
 * Whether `value` has the shape of a message id.
 *
 * Checked before anything else so a caller that passed a ROLE — the likeliest
 * mistake, since every other mail argument is an address — is told what it
 * did rather than told its message does not exist.
 *
 * The shape is the minting rule (`mail-<n>`), asserted rather than guessed:
 * ids are handed back by `mail.send` and are meant to be passed through
 * unchanged.
 */
export function isMessageId(value: string): boolean {
  return /^mail-\d+$/.test(value);
}
