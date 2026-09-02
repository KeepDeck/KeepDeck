/**
 * Following a live store with a dialect: read what was appended since last
 * time, turn it into edges, and say when the records stopped making sense.
 *
 * Sits above `read` the way [`walkSession`] does, and for the same reason —
 * so the loop is written once instead of once per agent. What is written
 * once here: resuming from a cursor, starting at the END rather than
 * replaying a session's history, noticing the store was rewritten rather
 * than appended to, and counting records the dialect could not place.
 *
 * WHY IT STARTS AT THE END. A followed store is read for what happens NEXT.
 * Its history is a record of turns that are over, and an old interrupt
 * replayed as if fresh would end a turn that is running — which is why the
 * host has always dropped replayed markers rather than acting on them.
 * Beginning at the current end says the same thing by construction, and it
 * is what makes following a big transcript cost nothing to start: a
 * forty-megabyte session opens at its last byte.
 *
 * The clock is the CALLER's. This does not own a timer, because how often to
 * look is a question about the app's liveness rather than about a format,
 * and a helper that owned one would be a helper every plugin has to be
 * trusted to stop.
 */
import type { AgentStatusEvent } from "./status.ts";
import type { PluginSessionStore, SessionCursor } from "./sessionRead.ts";
import { tailPass, type SessionTailDialect, type TailPass } from "./sessionTail.ts";

/** Where a following stands, and what its last look found. */
export interface FollowStep {
  /**
   * Where to resume. Absent means there is no position worth trusting — the
   * store was rewritten or could not be read — and the next look should
   * start over from its end.
   */
  readonly next?: SessionCursor;
  /** What the dialect made of the records this look passed through. */
  readonly pass: TailPass;
  /**
   * The store was replaced rather than appended to: a new session in the
   * same file, or a rotation. Everything the follower believed about
   * position is void, and a caller holding derived state should drop it.
   */
  readonly restarted: boolean;
}

const NOTHING: TailPass = { reported: 0, ignored: 0, unknown: 0 };

/**
 * Take one look at a followed store.
 *
 * `from` omitted means "begin here": the store is read only to find its end,
 * and nothing in it is reported. That is the honest reading of a history
 * whose turns are already over, and it is the whole of what arming costs.
 */
export async function followOnce<Req, Item>(input: {
  readonly store: PluginSessionStore;
  readonly dialect: SessionTailDialect<Req, Item>;
  /** The store to read, as the dialect's own `follow` described it. */
  readonly request: Req;
  /** Where the last look stopped, or omitted to begin at the end. */
  readonly from?: SessionCursor;
  readonly emit: (event: AgentStatusEvent) => void;
}): Promise<FollowStep> {
  const { store, dialect, request, from, emit } = input;
  const opening = from === undefined;
  const records: Item[] = [];
  const outcome = await store.read(
    dialect.format,
    // The cursor rides IN the request because only the transport knows how
    // to address a position in its own store — a byte for a file, something
    // else for a table. The dialect built the rest of it.
    { ...request, from } as Req,
    (record) => {
      // An opening read wants the END, not the records: taking them would
      // replay a whole session's turns as if they had just happened. The
      // budget still bounds it, and the cursor it hands back is what the
      // next look resumes from.
      if (!opening) records.push(record);
      return "more";
    },
  );

  if (outcome.stopped === "changed") {
    // The position we held describes a file that no longer exists under this
    // path. Nothing read in this pass can be trusted to belong to the store
    // we are now looking at, so nothing is reported.
    return { pass: NOTHING, restarted: true };
  }

  const pass = opening ? NOTHING : tailPass(dialect, records, emit);
  // `next` is absent on an exhausted read — the store ended, and the loop
  // that resumes from it would spin. Absent here means the same thing to the
  // caller as it does to `read`: begin from the end next time.
  return { next: outcome.next, pass, restarted: false };
}

/**
 * Whether a run of looks has stopped understanding this store.
 *
 * Two questions, not one, because they fail differently. A record that is
 * not JSON at all is a broken store and one is already suspicious; a record
 * that parses but carries a shape nobody claims is a format that MOVED, and
 * one of those is ordinary — a CLI adds a record type in a release — while a
 * run of them means this dialect has stopped reading its own agent.
 *
 * Held by the caller across looks rather than computed here: a single look
 * at a quiet store sees nothing at all, and a rule that fired on that would
 * fire on every idle pane.
 */
export function driftedAway(seen: TailPass): boolean {
  const placed = seen.reported + seen.ignored;
  // A majority of records nobody claims, and enough of them that it is not a
  // single release's new tag arriving alone.
  return seen.unknown >= 20 && seen.unknown > placed;
}

/** Add one look's counts to a running total, for [`driftedAway`]. */
export function addPass(total: TailPass, pass: TailPass): TailPass {
  return {
    reported: total.reported + pass.reported,
    ignored: total.ignored + pass.ignored,
    unknown: total.unknown + pass.unknown,
  };
}
