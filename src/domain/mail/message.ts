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
 * somebody is left waiting on it — `task` and `question` expect something
 * back ([`awaitsAnswer`]) while `note` merely informs, and `answer` is what
 * closes a question the receiver itself asked. A union rather than a free
 * string so a new kind is a compile error at every site that branches on it.
 *
 * It decides nothing about WHEN a message reaches a pane. It used to, and
 * every surface that told an agent so had to be found by hand — this one,
 * the briefing, the tool description, a plugin's static skill — which is why
 * the sentence agents read is composed from [`awaitsAnswer`] rather than
 * written out anywhere.
 */
export type MailKind =
  | "task"
  | "question"
  | "answer"
  | "note"
  /** The deck reporting on something this pane sent: that it is still
   * waiting, that it was dropped, or that it has been forgotten. Its own
   * kind rather than a `note` because the receiver must be able to tell a
   * fact about the mail system from a peer's words — and because a report
   * about a report would start a chain of its own. */
  | "undelivered"
  /** The deck telling a pane where it now stands: its team, its role, and
   * the roles it can write to. An agent cannot discover any of that on its
   * own — nothing about a pane's own process says it joined a team — so it
   * has to be told at the moment it happens, or it works alone without
   * knowing there was anyone to ask. */
  | "team";

/**
 * What an AGENT may put in `kind`.
 *
 * `undelivered` is missing on purpose: it is the deck's own word for a
 * delivery report, and a sender able to forge one could dress a message as a
 * fact about the mail system. `team` is missing for the same reason — a
 * briefing is the deck telling a pane where it stands, and standing context
 * bypasses the terminal entirely on the strength of that.
 *
 * A rule about the vocabulary, so it lives with the vocabulary: the command
 * layer offers it and the briefing explains it, and neither should be the
 * place that decides it.
 */
export const SENDABLE_KINDS: readonly MailKind[] = ["task", "question", "answer", "note"];

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
  /** The role this pane answered to when it spoke, if any.
   *
   * This, not `label`, is what the receiver is shown — because a receiver
   * replies to whatever it was told the sender was, and the role is the only
   * name that IS an address. Shown a pane title, an agent dutifully sent to
   * the title and was refused; it only got through on a second try after
   * being told the roles. Snapshot at send time for the same reason the
   * label is: roles move. */
  role?: string;
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
  /** The message this one answers, when the deck can say which — derived
   * from what the sender was owed, never named by the sender, which had no
   * way to be checked and taught agents to hoard ids. Correlation only:
   * nothing enforces that the answer ever comes. */
  replyTo?: string;
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

/**
 * What a receiver puts in `to` to answer this sender.
 *
 * The ROLE, because a receiver answers to whatever it is shown and only a
 * role is an address. A pane title is not one: shown a title, an agent sent
 * to the title and was refused. The title is the fallback for a sender on no
 * team, where there is no address to give.
 *
 * The third candidate — `paneId` — is deliberately NOT this. It always
 * resolves, which sounds like the safe answer and is the opposite of one:
 * `pane-N` is a reusable slot, so a stale id quietly reaches whoever
 * inherited it, while a stale role or title comes back as a refusal. Naming
 * the wrong pane is worse than naming none.
 *
 * A fact about the SENDER, not about a channel, which is why it lives here.
 * The three read paths derived it independently once, each carrying its own
 * copy of this reasoning; change one and that path's receivers keep getting
 * a name `resolveMailTarget` will refuse. [`senderName`] is the same answer
 * for a whole message, and is what the two delivery channels call.
 */
export function senderAddress(sender: MailSender): string {
  return sender.role ?? sender.label;
}

/**
 * The same answer for a whole message: the name a receiver will address its
 * reply TO, or null when the deck is speaking and there is nobody to answer.
 */
export function senderName(mail: Mail): string | null {
  return mail.from.kind === "pane" ? senderAddress(mail.from.pane) : null;
}
