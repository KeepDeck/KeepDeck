/**
 * What one record of an agent's OWN session store says about its pane, while
 * that store is still being written.
 *
 * The live sibling of [`SessionDialect`], and the split is the same one:
 * the host follows the file — polling it, holding the cursor, noticing it was
 * rewritten rather than appended to — and the plugin says what a record
 * MEANS. Neither half can be written by the other. The host knows transports
 * and has nowhere to name an agent; only the plugin knows that a claude
 * transcript records the user's Esc as a structured field on the record that
 * follows it.
 *
 * WHY THIS IS SEPARATE from the walking dialect rather than the same type:
 * a walk accumulates a conversation, so its step returns transcript entries
 * and its end flushes whatever is still held. Following a live store answers
 * a different question — what just happened to this pane — one record at a
 * time, with nothing to flush. Same principle, different work.
 *
 * WHAT IT IS FOR, today: the turn edges that reach the deck through no hook
 * at all. claude and codex push nothing when the user presses Esc, so their
 * transcript is the only witness — and the pane's whole idea of whether an
 * agent is working rests on that edge arriving. It used to be the HOST that
 * read `interruptedMessageId` out of a claude record and decided it meant an
 * interrupt; a plugin then translated the host's word back into the union
 * below. This lets the plugin read the record instead of the host's
 * paraphrase of it.
 */
import type { AgentStatusEvent } from "./status.ts";
import type { SessionFormat } from "./sessionRead.ts";

/**
 * A dialect for FOLLOWING one agent's store.
 *
 * Three members, and each answers a question only the plugin can:
 * which store, what a record means, and what silence is legitimate.
 */
export interface SessionTailDialect<Req, Item> {
  /** The transport this store speaks, and the record type it yields. */
  readonly format: SessionFormat<Req, Item>;

  /**
   * The store to follow for a live pane, or null when this agent has none to
   * follow yet.
   *
   * Topology belongs here because it is the agent's, not the app's: one CLI
   * keeps a root transcript beside a directory of subagent files, another a
   * day-partitioned tree, a third a single wire log. A host that knew those
   * shapes would be a host that names agents, and every new file-fed CLI
   * would be an edit to it.
   */
  follow(pane: TailTarget): Req | null;

  /**
   * What this record says about the pane's turn — or null, which is the
   * answer for the overwhelming majority of records in every store.
   *
   * The event is the host's closed union, so a dialect cannot report
   * something the deck has no meaning for, and cannot put a session's
   * contents on the app's bus by mistake: there is no field here to hold
   * them. `at` is the record's OWN instant when it carries one, because a
   * followed store is read up to a poll interval late and a marker stamped
   * with receipt time would outrank the turn it belongs behind.
   */
  read(record: Item): AgentStatusEvent | null;

  /**
   * Whether a record this dialect had nothing to say about is one it KNOWS
   * and deliberately passes over.
   *
   * The counterweight to `read` returning null for two different reasons.
   * Most records in a store are ordinary traffic — a user message, a tool
   * result — and skipping them is correct; a record whose shape this dialect
   * has never seen is a format that moved underneath us, and it is the only
   * warning anyone gets that a CLI changed its store.
   *
   * Without this the two are indistinguishable and the second is silent,
   * which is exactly how a drifted format goes unnoticed until somebody
   * reports that a pane has been "working" for an hour. Stated as a
   * predicate rather than a list of names so a dialect can answer for shapes
   * as well as for tags.
   */
  ignores(record: Item): boolean;
}

/** What the host can tell a dialect about the pane it is following. Small on
 * purpose: a dialect that needs more than the session it was given is a
 * dialect reaching for the app's business. */
export interface TailTarget {
  /** The session id this pane's CLI reported for itself, when it has
   * reported one. A pane whose agent has not spoken yet has none. */
  readonly sessionId: string | null;
  /** The directory the pane's process runs in. Some stores are addressed by
   * the working directory rather than by a session id. */
  readonly cwd: string | null;
}

/**
 * What one pass over a followed store did, from the host's side.
 *
 * `unknown` is the whole reason this exists as a report rather than a plain
 * event stream: it counts records that were neither read nor knowingly
 * ignored. One is a curiosity; a run of them is a format that moved, and the
 * host is the only side that can compare that count against the traffic it
 * saw and say so out loud.
 */
export interface TailPass {
  /** Records the dialect turned into an edge. */
  readonly reported: number;
  /** Records it knowingly passed over. */
  readonly ignored: number;
  /** Records it neither reported nor claimed to know. */
  readonly unknown: number;
}

/**
 * Run one batch of records through a dialect, counting what it did.
 *
 * Lives here rather than in the host so the counting rule is the same on
 * both plugin tiers and cannot be re-derived differently by either: a record
 * is unknown when the dialect neither reported it nor claimed it, and that
 * is the only definition anyone gets.
 */
export function tailPass<Req, Item>(
  dialect: SessionTailDialect<Req, Item>,
  records: Iterable<Item>,
  emit: (event: AgentStatusEvent) => void,
): TailPass {
  let reported = 0;
  let ignored = 0;
  let unknown = 0;
  for (const record of records) {
    const event = dialect.read(record);
    if (event) {
      reported += 1;
      emit(event);
      continue;
    }
    // Asked only of records the dialect said nothing about, so a dialect
    // pays for the predicate once per silence rather than once per record.
    if (dialect.ignores(record)) ignored += 1;
    else unknown += 1;
  }
  return { reported, ignored, unknown };
}
