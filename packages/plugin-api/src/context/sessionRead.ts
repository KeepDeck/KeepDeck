/**
 * Reading an agent's SESSION STORE without holding it.
 *
 * A store is a conversation on disk, and the only thing every agent's store
 * has in common is that it is too big to want in memory at once. What differs
 * is everything else: the framing (a line, a database row), the record shape,
 * what a record means. So the split is: the HOST frames, decodes, counts the
 * budget, mints cursors and checks the source did not move underneath; the
 * PLUGIN says what one record of its own format means, and nothing else.
 *
 * The host knows no agent here, and never will — it knows transports. The
 * plugin knows no number here, and cannot: the budget is not a parameter, so
 * "plugins hold no sizes" is a property of the signature rather than a
 * convention someone has to keep.
 */

import type { PluginFs } from "./services.ts";
import { createJsonlReader, type JsonlRequest } from "./sessionReadJsonl.ts";

/**
 * Where a read stopped, as a token only the host can mint.
 *
 * Deliberately opaque rather than `{ byte, size }`. A resume position must
 * land on a record boundary, and the only party that knows where the
 * boundaries are is the one that framed them — a plugin physically cannot
 * compute a correct one, and the type says so. A readable structure would
 * also invite arithmetic on its fields, and a hand-built cursor pointing into
 * the middle of a record reads garbage with no error anywhere.
 */
export type SessionCursor = string & { readonly __sessionCursor: unique symbol };

/**
 * A store format, as a typed descriptor.
 *
 * The descriptor carries the correspondence "this format takes THIS request
 * and yields THESE items" in its own type, instead of a central table naming
 * every format — and it carries it in what it DOES: `open` is the format's
 * reader, built over the fs it is handed. A table would put the list of
 * formats back inside the host, and a registry keyed by id could only hand
 * its readers back by asserting their types; a descriptor that opens its own
 * reader needs neither.
 *
 * The transports are still this package's to define: a format is made by
 * one of its constructors (`jsonl`), never by a plugin, and whatever reader
 * one opens reads through the plugin's OWN gated fs — no reach the plugin
 * did not already have.
 */
export interface SessionFormat<Req, Item> {
  readonly id: string;
  open(fs: PluginFs): SessionReader<Req, Item>;
}

/**
 * The `jsonl` format: one JSON value per line, handed over as `Record` once
 * `accepts` says it is one.
 *
 * The guard is the plugin's, because only the plugin knows its records; the
 * host parses the JSON and checks nothing else. A line that parses but that
 * the guard refuses is not passed on and not dropped either: it is counted
 * (`ReadOutcome.refused`), so a reading says when the store held something it
 * could not use — the mark a format that moved underneath us leaves.
 */
export function jsonl<Record>(accepts: (value: unknown) => value is Record): SessionFormat<JsonlRequest, Record> {
  return { id: "jsonl", open: (fs) => createJsonlReader(fs, accepts) };
}

export type { JsonlRequest };

/** Why a read stopped. Four reasons rather than one `truncated` flag,
 * because they do not mean the same thing to the person at the other end:
 *
 * - `exhausted` — the store ended. The data is complete.
 * - `budget` — the host stopped it. The data is INCOMPLETE and the caller
 *   owes the user a mark saying so.
 * - `satisfied` — the caller said "enough". Complete for its purpose, and a
 *   mark here would be a lie: nothing was lost, the caller stopped looking.
 * - `changed` — the store moved under the cursor. What was read is not one
 *   consistent state of one file; the answer is to start over, not to show a
 *   shorter version.
 * - `unreadable` — a window came back as something other than text, or the
 *   read could not advance. Nothing to retry and nothing more to get, but
 *   unlike `exhausted` the conversation did NOT end here.
 *
 * A boolean would fuse `budget` with `satisfied` and mark half the complete
 * reads as truncated; it would fuse `changed` with both and show a user the
 * spliced halves of two different files as one shortened conversation. */
export type ReadStop =
  | "exhausted"
  | "budget"
  | "satisfied"
  | "changed"
  | "unreadable";

export interface ReadOutcome {
  /** Bytes of the store this read passed through — what the budget bounds,
   * and what memory tracks. */
  payloadBytes: number;
  /** Records handed to `consume`. */
  items: number;
  /** Records the format's guard refused — present, and above zero, only when
   * there were some. They were read (their bytes count) and passed over;
   * the conversation around them is still whole. */
  refused?: number;
  stopped: ReadStop;
  /** The store's full size in the same measure as `payloadBytes`, when the
   * transport has one (a file does; a table does not). Present so a caller
   * can say "read X of Y" without opening the store a second time to find
   * out what Y was. */
  sourceBytes?: number;
  /** Where to continue — present exactly when there IS more to read now
   * (`budget`, `satisfied`). Absent on `exhausted` so a loop terminates on
   * the field it resumes from, and absent on `changed` / `unreadable`
   * because there is no position worth trusting. */
  next?: SessionCursor;
}

/**
 * How far into a store a read intends to go.
 *
 * `whole` is a reading of the conversation. `head` is a reading of the facts
 * a store records at its start — a working directory, a name — for a caller
 * that would otherwise walk megabytes it will not look at.
 *
 * The caller states its INTENT and the host supplies the distance, because
 * the two belong to different parties: "my facts are at the start" is a true
 * claim about one agent's format and a false one about another's, and only
 * the plugin can make it — while how far "the start" reaches is a statement
 * about this app's memory, which no plugin should be setting.
 */
export type ReadScope = "whole" | "head";

/** How much of a store ONE read may pass through.
 *
 * Universal, and therefore here rather than in a transport: a statement about
 * the app's memory, not about lines or rows. `whole` matches the per-session
 * cap the file-backed plugins each carried privately, so nothing reads less
 * than before — what changes is that the bytes arrive a window at a time
 * instead of all at once. `head` matches the head codex already reads today,
 * chosen so that adopting the scope changes no answer at all. */
const BUDGETS: Readonly<Record<ReadScope, ReadBudget>> = {
  whole: { maxPayloadBytes: 8 * 1024 * 1024 },
  head: { maxPayloadBytes: 256 * 1024 },
};

export interface ReadBudget {
  readonly maxPayloadBytes: number;
}

/**
 * One transport. The chunk size, the framing and the resume arithmetic belong
 * to the implementation — they are what differs between a file and a table —
 * while the budget arrives from above, because it does not.
 */
export interface SessionReader<Req, Item> {
  pull(
    request: Req,
    budget: ReadBudget,
    consume: (item: Item) => "more" | "enough",
  ): Promise<ReadOutcome>;
}

/**
 * Read a session store record by record.
 *
 * `consume` is called with one decoded record at a time and answers whether
 * it wants more. Nothing accumulates here: what the caller keeps is what the
 * caller kept.
 */
export interface PluginSessionStore {
  read<Req, Item>(
    format: SessionFormat<Req, Item>,
    request: Req,
    consume: (item: Item) => "more" | "enough",
    /** How far this reading means to go; omitted = the whole conversation. */
    scope?: ReadScope,
  ): Promise<ReadOutcome>;
}

/**
 * The service, over whatever `fs` the caller is entitled to.
 *
 * Built from a plugin's OWN gated `fs`, on both tiers: a built-in gets the
 * capability gate's, an external guest gets its RPC proxy onto the same gate.
 * So this adds no reach of its own — a store it can read is a file the plugin
 * could already have read, only now it need not hold one.
 *
 * Running in the guest rather than behind another RPC verb is what keeps the
 * external tier honest: windows cross the realm boundary, records never do,
 * so a big store costs a message per 256 KB instead of one per record.
 */
export function createSessionStore(fs: PluginFs): PluginSessionStore {
  return {
    read(format, request, consume, scope = "whole") {
      // The format opens its own reader, typed by its own descriptor; the
      // store supplies the fs and the budget — the two things that are not
      // the format's to choose.
      return format.open(fs).pull(request, BUDGETS[scope], consume);
    },
  };
}
