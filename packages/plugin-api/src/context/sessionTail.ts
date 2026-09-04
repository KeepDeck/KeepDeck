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
   * Which records are worth carrying out of the store at all, said as DATA
   * so the side that reads the bytes can apply it without understanding it.
   *
   * This is what keeps the follower cheap without teaching the reader a
   * format. Measured on real stores, a filter like this passes a few percent
   * of the bytes; without one, following a claude transcript would carry a
   * third of a gigabyte of message content to somebody who wants four
   * fields. The reader compares keys and copies the ones named — it cannot
   * tell an interrupt from a tool result, and does not need to.
   *
   * Deliberately two rules and no more. Equality and presence, joined by
   * "and", with no nesting and no "or": everything past that belongs in
   * [`read`], where a real language already exists. A descriptor that grows
   * conditions is a query language nobody voted for.
   *
   * A LIST, because a store answers with more than one shape: the numbers
   * arrive as one kind of record and the model that qualifies them as
   * another, and joining those into a single condition would need the `or`
   * this deliberately does not have. Tried in order, and the FIRST match
   * carries — so a dialect that wants two readings of one record has to say
   * so in `read`, where saying so is cheap.
   */
  readonly watches: readonly TailWatch[];

  /**
   * The store to follow for a live pane, or null when this agent has none to
   * follow yet.
   *
   * Topology belongs here because it is the agent's, not the app's: one CLI
   * keeps a root transcript beside a directory of subagent files, another a
   * day-partitioned tree, a third a single wire log. A host that knew those
   * shapes would be a host that names agents, and every new file-fed CLI
   * would be an edit to it.
   *
   * ASYNC because finding a store can mean looking for it. An agent that
   * names its own file answers immediately; one that reports only a session
   * id has to be searched for, and that search is the plugin's — it is the
   * same walk its history browser already does over the same tree.
   */
  follow(pane: TailTarget): Promise<Req | null>;

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

/**
 * One condition on a record's field, named by a dotted path.
 *
 * The path arrived because a second store needed it and could not be
 * expressed without it: codex records an abort as `payload.type`, one level
 * down, so a descriptor that could only see top-level keys would have failed
 * for one of the two agents it exists to serve. It is traversal and nothing
 * more — still equality or presence, still joined by "and", still no `or`.
 * A condition this cannot say belongs in [`read`], where a real language
 * already exists.
 */
export interface RecordMatch {
  /** The field this clause is about: `type`, or `payload.type`. */
  readonly key: string;
  /** The exact string it must hold. Omit to ask only that it is there. */
  readonly equals?: string;
}

/** Walk a dotted path. Anything that is not an object on the way down ends
 * the walk — a store that changed a field's shape reads as absence rather
 * than as a crash. */
function at(record: unknown, path: string): unknown {
  let held: unknown = record;
  for (const segment of path.split(".")) {
    // An ARRAY is not an object here, however JavaScript classes it. The
    // segment would otherwise read as an index and `items.0` would resolve —
    // on this side only, since the host walks objects alone. A plugin would
    // then test a watch that works in its own suite and carries nothing in
    // production. Caught by the shared corpus on its first run.
    if (typeof held !== "object" || held === null || Array.isArray(held)) {
      return undefined;
    }
    held = (held as Record<string, unknown>)[segment];
  }
  return held;
}

/**
 * What to carry out of a store, and what to leave in it.
 *
 * `keep` is the half that matters for more than cost: a record crosses as
 * the named fields and nothing else, so a store's contents cannot ride out
 * of it by accident. A dialect that never names a message field cannot leak
 * a message — not as a rule anyone has to remember, but because the field
 * was never copied.
 */
export interface TailWatch {
  /** Every clause must hold for the record to be carried. */
  readonly match: readonly RecordMatch[];
  /** Top-level keys to copy. Nothing else leaves the store. */
  readonly keep: readonly string[];
  /**
   * Which channel the carried record belongs on.
   *
   * Declared rather than derived, because deriving it would mean reading the
   * record — and the whole point of the descriptor is that the side applying
   * it does not. A store's records answer two different questions: what the
   * turn is doing, and what it cost. Nothing about a record's SHAPE says
   * which, so the dialect that named it says.
   */
  readonly lane: TailLane;
  /**
   * Fold these records into a running session total, stamped onto each one
   * as it is carried.
   *
   * DECLARED rather than done here, and that is not a compromise — it is the
   * only arrangement that works. A session store is read once at arming, and
   * the reader keeps the LAST record of each watch rather than every one: a
   * large transcript holds twelve thousand rows that carry counts, and
   * handing them all over to be added up would cost eight megabytes across
   * the boundary every time a pane is armed. So the addition has to happen
   * where the bytes already are, and what travels is the sum.
   *
   * What that side must NOT have is an opinion about it. Which records carry
   * counts, which buckets a total is made of, and whether repeated rows are
   * one message or several are all facts about one CLI's format — so they
   * are said here, as data, and applied by a reader that adds the numbers it
   * was named without knowing what any of them mean.
   */
  readonly sum?: TailSum;
}

/**
 * A running total over the records one watch carries.
 *
 * The whole arithmetic, and deliberately no more: named buckets, added up,
 * with one rule for stores that repeat themselves. Anything a store needs
 * beyond this is interpretation, and interpretation belongs to the plugin's
 * own normalizer — which reads the stamped total the same as any other
 * field.
 *
 * WHERE THE LINE IS, for whoever is tempted to widen this. What may live
 * here is a fold that is COMMUTATIVE per key: the answer must not depend on
 * the order records arrived in, because the reader replays a file from
 * wherever its cursor happens to be and has no notion of a first or a last.
 * `dedupBy` qualifies — a per-key maximum is the same however the rows are
 * shuffled. "The newest row wins", "subtract a baseline", "only rows where
 * X" do not: each needs an ordering or a condition, and adding one turns a
 * description into a small language with a control flow nobody voted for.
 * Those belong in [`SessionTailDialect.read`], where a real language already
 * exists and the plugin — which knows the format — is the one running it.
 */
export interface TailSum {
  /**
   * The buckets to add: the name each total is stamped under, mapped to the
   * dotted path it is read from on the original record.
   *
   * Separate buckets rather than one number because they are not
   * interchangeable — a re-read context prefix is not fresh input, and
   * summing them together would report a session as having spent what it
   * merely re-sent.
   */
  readonly buckets: Readonly<Record<string, string>>;
  /**
   * The field identifying which message a row belongs to, when a store
   * writes one message as several rows.
   *
   * A claude transcript repeats an assistant message id as its content and
   * tool blocks arrive, each row restating the message's counts so far.
   * Added plainly they would multiply a turn's cost by the number of blocks
   * in it; rows sharing this field are instead held at each bucket's
   * MAXIMUM, and only the growth joins the total. Omit for a store whose
   * every row is its own event.
   */
  readonly dedupBy?: string;
  /** The key the running total is stamped under on each carried record. */
  readonly stampAs: string;
}

/** The two questions a session store answers. `status` moves the pane's
 * card and gates mail delivery; `usage` moves the numbers. They are separate
 * because they fail differently: a wrong status stops mail, a wrong number
 * misinforms. */
export type TailLane = "status" | "usage";

/**
 * The type a carried record travels under, on either lane.
 *
 * One name for every dialect, and one DEFINITION of that name: the reader
 * that stamps it and every plugin that recognizes it are agreeing on a wire
 * literal, and a literal agreed in four places is one rename away from a
 * plugin that silently stops seeing its own records.
 */
export const CARRIED_RECORD = "store.record";

/** Whether a record satisfies every clause. The host applies this; it lives
 * here so both sides read the descriptor the same way, and so a plugin can
 * test its own watch without a host. */
export function watchMatches(
  watch: TailWatch,
  record: Readonly<Record<string, unknown>>,
): boolean {
  return watch.match.every((clause) => {
    const value = at(record, clause.key);
    if (clause.equals !== undefined) return value === clause.equals;
    // Presence, and an empty string is not presence: a key written blank is
    // how several stores say "no value", and treating it as one would carry
    // records that say nothing.
    return value !== undefined && value !== null && value !== "";
  });
}

/**
 * The named fields and nothing else.
 *
 * A dotted name survives as a dotted KEY rather than rebuilding the nesting:
 * the carried record is a small flat thing to be read once, and reproducing
 * a shape would invite a dialect to expect the rest of it. What was asked
 * for is what arrives, under the name it was asked for.
 */
export function watchProject(
  watch: TailWatch,
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of watch.keep) {
    const value = at(record, key);
    if (value !== undefined) kept[key] = value;
  }
  return kept;
}

/** What the host can tell a dialect about the pane it is following. Small on
 * purpose: a dialect that needs more than the session it was given is a
 * dialect reaching for the app's business. */
export interface TailTarget {
  /** The session id this pane's CLI reported for itself, when it has
   * reported one. A pane whose agent has not spoken yet has none. */
  readonly sessionId: string | null;
  /** The store this pane's CLI named for itself, when its reporter says so.
   *
   * Present for an agent that tells the deck where it writes; absent for one
   * that does not, and then finding the store is the dialect's own work —
   * which is the point of asking the dialect rather than deriving a path in
   * the host. A path that arrives here was REPORTED, so it needs no rule
   * about slugs or day-partitioned trees to reconstruct. */
  readonly store: string | null;
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
