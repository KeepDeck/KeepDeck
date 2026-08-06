/**
 * What one message between two agent panes IS.
 *
 * Deliberately not a chat model: no threads, no read receipts, no ordering
 * promise beyond "one receiver reads one message at a time". A message
 * carries only what the host CANNOT observe for itself — a question, a
 * course correction, an answer. Everything it can (who is working, on what
 * branch, in which worktree) stays out, because answering that from state
 * costs neither a turn nor a token, and a roster that travels by mail is a
 * roster paid for twice.
 */
import type { CommandSource } from "../commands";

/**
 * What the message is FOR.
 *
 * Not decoration: it is the one hint the receiving agent gets about whether
 * this interrupts (`task`, `question`) or merely informs (`note`), and
 * `answer` is what closes a question the receiver itself asked. A union
 * rather than a free string so a new kind is a compile error at every site
 * that branches on it.
 */
export type MailKind =
  | "task"
  | "question"
  | "answer"
  | "note"
  /** A delivery report: something this pane sent never landed. Its own kind
   * rather than a `note` because the receiver must be able to tell a fact
   * about the mail system from a peer's words — and because a report about
   * a report would start a chain of its own. */
  | "undelivered";

/**
 * The pane that sent it, as it read AT SEND TIME.
 *
 * `label` is copied rather than looked up on read for the reason the journal
 * copies it (`CommandSource.external.pane`): `pane-N` is a REUSABLE slot, so
 * a message that outlives its sender would otherwise name whoever inherited
 * the number.
 */
export interface MailSender {
  paneId: string;
  workspaceId: string;
  label: string;
}

/**
 * Who spoke. A union rather than an optional pane, because the two cases
 * differ in what the receiver may DO with the message: a peer's words are
 * another agent's output and are to be weighed, while a host notice is a
 * fact about the mail system and answering it goes nowhere. Modelling the
 * host as "a sender with no pane" would leave every read site free to forget
 * the difference.
 */
export type MailFrom =
  | { kind: "pane"; pane: MailSender }
  /** KeepDeck itself. Only ever a delivery report — the host has nothing to
   * say to an agent that the deck cannot already show a person. */
  | { kind: "host" };

/** One message, from the moment it is accepted to the moment it lands. */
export interface Mail {
  id: string;
  kind: MailKind;
  body: string;
  from: MailFrom;
  /** The receiving pane. */
  toPaneId: string;
  /** When the SENDER spoke. Expiry runs on this clock, not on when delivery
   * was last attempted — see [`decideDelivery`]. */
  at: number;
  /** The message this one answers, when the sender named one. Correlation
   * only: nothing enforces that the answer ever comes. */
  replyTo?: string;
  /** How many mail-caused wakes this chain has already spent — the counter
   * [`decideSend`] bounds. Zero means this message opens a chain. */
  hop: number;
}

/**
 * The sender behind a command call, or null when the caller cannot be named.
 *
 * Null is a REFUSAL, not a degradation. Three callers land here: the host
 * (no pane behind a palette or a hotkey), a plugin, and an anonymous MCP
 * client — a server the user wired by hand, or a kimi pane sharing its cwd
 * with another, which is deliberately left anonymous rather than risk naming
 * the wrong pane (`src/app/mcp/injection.ts`). None of them can receive a
 * reply, so a message from any of them is a dead end the receiver would
 * spend a turn discovering.
 */
export function senderOf(source: CommandSource): MailSender | null {
  if (source.kind !== "external" || !source.pane) return null;
  const { id, workspaceId, label } = source.pane;
  return { paneId: id, workspaceId, label };
}
