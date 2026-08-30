/**
 * One walk over a session store, for the plugins that need the conversation
 * rather than the records.
 *
 * `sessionStore.read` hands over records; every history plugin then does the
 * same four things with them — accumulate turns up to a cap, derive a title,
 * flush whatever the dialect still holds, and turn "why the read stopped"
 * into a mark for the user. Written once here, those four stop being four
 * things each plugin author has to remember.
 *
 * What is left for the plugin is a DIALECT: three pure functions that say
 * what one record of its own format means. No reading, no sizes, no
 * accumulation — and no way to forget the flush, because this calls it.
 */

import type { AgentTranscriptEntry, Shortfall } from "./agents.ts";
import { firstMeaningfulUserTurn } from "./historyText.ts";
import type {
  PluginSessionStore,
  ReadOutcome,
  ReadScope,
  SessionFormat,
} from "./sessionRead.ts";

/**
 * How much conversation text one walk keeps, in the characters it is held
 * in. The store's own budget bounds what is READ; this bounds what is kept,
 * and they are different questions — a store can spend megabytes of records
 * on very little text.
 *
 * The value is the one the host already imposed on a session's indexed
 * content, moved to where the text is produced instead of where it lands.
 */
export const CONTENT_CAP = 2 * 1024 * 1024;

/**
 * What one record of a particular agent's format means.
 *
 * `begin`/`end` exist for the dialects that cannot decide a turn from a
 * single record: kimi accumulates assistant fragments and only knows the
 * turn is over when the next user message arrives, so at the end of any read
 * it is still holding one. `end` is called on EVERY exit, including a stop
 * on the budget — a dialect that loses its last turn loses it silently, with
 * no error and no shortfall, and only a diff against the old output would
 * ever show it.
 */
export interface SessionDialect<State, Item> {
  /** Fresh state for one walk. */
  begin(): State;
  /** Zero or more turns this record completes. */
  step(state: State, item: Item): AgentTranscriptEntry[];
  /** Whatever the dialect is still holding. */
  end(state: State): AgentTranscriptEntry[];
}

export interface WalkedSession<State> {
  /** The first real user turn, by the shared heuristic. A plugin whose store
   * carries a better name of its own applies that precedence itself — the
   * heuristic is the floor, not the last word. */
  title?: string;
  /** The turns' text, joined — the form the session index consumes. */
  content: string;
  turns: AgentTranscriptEntry[];
  /** What the user must be told was left out; absent when nothing was. */
  shortfall?: Shortfall[];
  outcome: ReadOutcome;
  /** The dialect's state as the walk left it, so a plugin can read what its
   * own records said in passing — a working directory, a summary line — from
   * the walk that was going to pass them anyway, instead of opening the store
   * a second time to look. */
  state: State;
}

/**
 * A mark ONLY when something was actually lost.
 *
 * `satisfied` is the trap: the walk stops the read the moment it has all the
 * text it keeps, so most complete sessions end that way. Marking those would
 * put "partly shown" on the majority of healthy conversations, and a warning
 * that fires on everything stops being read at all.
 *
 * A `head` reading is the same trap in another shape. It never meant to read
 * the conversation, so stopping at the head's end is not a shortfall — it is
 * the reading working as asked. A mark here would say "part of this session
 * is missing" about a session nobody was reading.
 */
function shortfallOf(
  outcome: ReadOutcome,
  scope: ReadScope,
): Shortfall[] | undefined {
  if (scope === "head") return undefined;
  if (outcome.stopped === "exhausted" || outcome.stopped === "satisfied") {
    return undefined;
  }
  if (outcome.sourceBytes === undefined) return undefined;
  return [
    { kind: "bytes", size: outcome.sourceBytes, readBytes: outcome.payloadBytes },
  ];
}

export async function walkSession<Req, Item, State>(opts: {
  store: PluginSessionStore;
  format: SessionFormat<Req, Item>;
  request: Req;
  dialect: SessionDialect<State, Item>;
  /**
   * Keep only this slice of the turns, and stop once it is full — a page of
   * a transcript rather than the conversation.
   *
   * It lives here rather than in each plugin because a page needs the same
   * things a whole walk does: the dialect driven, the shortfall derived, and
   * `end` called. Written per plugin, the page loop would be the copy this
   * mechanism exists to delete, and the one place a forgotten flush hides.
   *
   * The content cap does NOT apply to a slice: `limit` already bounds it,
   * and the cap would cut a legitimate page out of a long conversation.
   */
  keep?: { offset: number; limit: number };
  /**
   * Stop as soon as the dialect has what the caller came for.
   *
   * The third way to stop, beside "the text is full" and "the slice is
   * full", and the only one whose condition the plugin owns — because only
   * the plugin knows what it came for. It says WHAT has been collected, never
   * how much has been read: a byte count here would be a size back in a
   * plugin, by another name.
   *
   * It sees the turns as well as the dialect's state, so a caller waiting on
   * something the SHARED derivations produce — a title, say — can wait on it
   * without re-deriving it privately. Re-deriving is how two spellings of one
   * rule appear, and they drift.
   */
  until?: (state: State, turns: readonly AgentTranscriptEntry[]) => boolean;
  /**
   * How far this walk means to go; omitted = the whole conversation.
   *
   * `"head"` is for a reading that only wants the facts a store records at
   * its start. It is a claim the PLUGIN makes about its own format — true of
   * one agent's store and false of another's — while the distance it buys is
   * the host's to set. A walk that says it only wanted the head does not
   * report the session as incomplete when the head ends.
   */
  scope?: ReadScope;
}): Promise<WalkedSession<State>> {
  const {
    store,
    format,
    request,
    dialect,
    keep: slice,
    until,
    scope = "whole",
  } = opts;

  // A store that moved under the read was two different files, and splicing
  // their halves would show a conversation that never happened. Once is a
  // retry; twice is a store being written faster than it can be read, and
  // reading it a third time would only cost more of the same.
  for (let attempt = 0; ; attempt++) {
    const state = dialect.begin();
    const turns: AgentTranscriptEntry[] = [];
    let chars = 0;
    /** Turns the dialect has produced, counted whether kept or skipped past —
     * a slice needs to know where it is in the conversation. */
    let seen = 0;
    let full = false;

    const take = (produced: AgentTranscriptEntry[]): void => {
      for (const turn of produced) {
        if (slice !== undefined) {
          if (seen >= slice.offset && turns.length < slice.limit) turns.push(turn);
          seen += 1;
          if (turns.length >= slice.limit) full = true;
          continue;
        }
        if (chars >= CONTENT_CAP) {
          full = true;
          return;
        }
        turns.push(turn);
        chars += turn.text.length + 1;
      }
    };

    const outcome = await store.read(
      format,
      request,
      (item) => {
        take(dialect.step(state, item));
        if (until?.(state, turns) === true) return "enough";
        return full ? "enough" : "more";
      },
      scope,
    );
    take(dialect.end(state));

    if (outcome.stopped === "changed" && attempt === 0) continue;

    const shortfall = shortfallOf(outcome, scope);
    return {
      title: firstMeaningfulUserTurn(turns),
      content: turns.map((t) => t.text).join("\n"),
      turns,
      ...(shortfall ? { shortfall } : {}),
      outcome,
      state,
    };
  }
}
