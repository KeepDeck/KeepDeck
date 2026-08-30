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
 * every format. That is the whole point: a table would put the list of
 * formats back inside the host, so adding one would mean editing a type that
 * belongs to nobody, and the registry would be open in name and closed in
 * types.
 *
 * The two `__` fields exist only to carry `Req` and `Item` into inference.
 * They are never read and never present at runtime — an unused type parameter
 * is invisible to TypeScript's inference, so it has to be witnessed by a
 * member.
 */
export interface SessionFormat<Req, Item> {
  readonly id: string;
  readonly __request?: Req;
  readonly __item?: Item;
}

/** The `jsonl` format: one JSON value per line. `Record` is the plugin's
 * assertion about its own records, made once here and typed from then on —
 * the host parses JSON and does not pretend to validate a shape it knows
 * nothing about. */
export function jsonl<Record = unknown>(): SessionFormat<JsonlRequest, Record> {
  return JSONL as SessionFormat<JsonlRequest, Record>;
}

const JSONL: SessionFormat<JsonlRequest, unknown> = { id: "jsonl" };

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
  // Formats by id. The map is the closed part — the host decides which
  // transports exist — and the descriptor is the open part: adding a format
  // is a reader, a descriptor and one line here, with no central type to
  // widen and no other plugin to touch.
  //
  // The two casts are the price of a heterogeneous registry: a `Map` cannot
  // say "the value's type parameters are whatever the key's descriptor
  // declares". The descriptor IS that witness, and it comes from us — a
  // caller cannot name a format we do not serve, so `read` below recovers
  // exactly the types the caller already proved.
  const readers = new Map<string, SessionReader<unknown, unknown>>([
    [JSONL.id, createJsonlReader(fs) as SessionReader<unknown, unknown>],
  ]);

  return {
    read(format, request, consume, scope = "whole") {
      const reader = readers.get(format.id) as
        | SessionReader<typeof request, Parameters<typeof consume>[0]>
        | undefined;
      if (reader === undefined) {
        return Promise.reject(
          new Error(`sessionStore.read: no reader for format "${format.id}"`),
        );
      }
      return reader.pull(request, BUDGETS[scope], consume);
    },
  };
}
