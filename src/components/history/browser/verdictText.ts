import type { Shortfall } from "@keepdeck/plugin-api";

/**
 * What the transcript viewer SAYS about its own reading ([F8] browser).
 *
 * APPLICATION LOGIC BY NATURE, PRESENTATION-HOMED WHILE IT HAS ONE CALLER.
 * `readingVerdict` does not format or render — it DECIDES which verdict is
 * true of a reading, over facts (`shortfall`, `exhausted`, `viewerError`) that
 * the browser seam produces, not the screen. A second consumer moves it to
 * `src/app` beside [`resumeOutcome`], which lives there for exactly that
 * reason: its wording is shared by two surfaces and exists so they say the
 * same thing about the same state. Until then this is the lightest form of
 * application logic — one caller, no IPC, no deck access — and the file sits
 * next to that caller. Do not import it from anywhere else without moving it;
 * the move is then a decision, not a drift.
 *
 * The count is a CONSEQUENCE, not the law. What puts a module in the
 * application layer is OWNERSHIP — of state, of a lifecycle, of a port — and
 * this owns none: it reads an owner's facts and says what is true of them. So
 * proximity is not an argument either: the reading's owner moved to `src/app`
 * and that changes nothing here, exactly as a pure function over deck state
 * would not follow the deck's store. Two consumers move it because being the
 * vocabulary of two surfaces is itself the application layer's job.
 *
 * These are verdicts about a READING, never about a session: the same session
 * read twice can fall short differently, and a mark inherited from yesterday's
 * scan would describe a file that has since grown. Every phrase here names
 * what THIS read did.
 *
 * The rules live in the BODY of `readingVerdict`, not in comments beside the
 * JSX, because they are rules about WHICH SENTENCE WINS — and a rule that
 * exists only as prose cannot be witnessed. One state answers with exactly one
 * arrangement, and reordering the branches reddens in a single place.
 *
 * The sentences are deliberately NOT exported. Each is a product decision with
 * a rejected alternative behind it, and the test that guards it must hold its
 * own copy: a test importing these constants would compare them to themselves
 * and stay green through any rewording, catching a broken branch but never a
 * broken word. That is the opposite of the usual rule against a second copy —
 * two places obliged to agree BY THEMSELVES are a defect, while an outside
 * witness holding its own copy is the only way it can witness anything.
 *
 * If a second consumer of these sentences ever appears, that is a reason to
 * re-read the split — not to open the export. The screen's words and the scan
 * log's words are already separate for a reason (different reader, different
 * reading), and a shared export would be the first step back toward one
 * vocabulary answering to two audiences.
 */

/** Not "the file is X": the size speaks for itself elsewhere, and this
 * sentence is about the READ. No unit in the line — "X of Y" reads as volume
 * in a viewer, and the unit belongs in the tooltip. */
const PARTLY_SHOWN = (readBytes: number, size: number) =>
  `Partly shown — read ${readBytes} of ${size}`;

const TURNS_SHOWN = (returned: number, total: number) =>
  `${returned} of ${total} turns`;

/** "in this conversation", NOT "in what is shown". What is shown changes as
 * the reader pages; the reading's shortfall does not. A promise about the
 * shown text would swing back and forth under scrolling without a single fact
 * having changed. */
const UNREADABLE_PARTS = (n: number) =>
  `Conversation has ${n} unreadable parts`;

/** The reading reached the end and stopped there. Not "beyond the file": the
 * file may well be whole, and we do not know that and do not promise it. No
 * "may" — the uncertainty is named by its boundary, not by a mood. */
const ENDING = "Read up to here — the rest is beyond this reading";

/** The reading happened, fell short, and produced nothing to show. Not
 * "Partly shown" (nothing is), not "No transcript content" (there is plenty),
 * not "Read failed" (the read succeeded), not "Transcript unreadable" (what
 * would not read is a character at the boundary, not the transcript). */
const NOTHING_SHOWN = "Read cut short — nothing could be shown";

/** A refusal AFTER turns were already shown. "Stopped", not "failed": the
 * showing happened and the continuation is what broke. "did not arrive" names
 * the refusal as an absence rather than as someone's fault. Paired with the
 * viewer's own "Read failed" — which answers a refusal BEFORE anything was
 * shown — and the two are told apart by WHAT WAS SHOWN, never by cause. */
const STOPPED = "Stopped mid-read — the rest did not arrive";

/** A genuinely empty transcript: every line was noise. Kept last on purpose —
 * see the hierarchy below. */
const EMPTY = "No transcript content";

/** One kind's sentence. The screen LISTS them, never joins them: joining
 * invents a third meaning belonging to no kind — the same "one number for
 * three purposes" we buried, moved up to the level of the sentence. A fourth
 * kind adds a line here and rewrites nothing. */
function noticeOf(kind: Shortfall): string {
  switch (kind.kind) {
    case "bytes":
      return PARTLY_SHOWN(kind.readBytes, kind.size);
    case "turns":
      return TURNS_SHOWN(kind.returned, kind.total);
    case "parts":
      return UNREADABLE_PARTS(kind.unreadableParts);
  }
}

export interface ReadingState {
  /** Turns ACCUMULATED across the pages read so far, not this page's count. */
  entries: number;
  /**
   * The list stopped growing — honestly (a page came back short of its limit)
   * or because a read refused.
   *
   * Load-bearing, and NOT derivable from the rest: a capped file carries the
   * SAME shortfall on every page, because each page re-reads the whole file
   * under the same ceiling. Without this flag "page one of five" and "this
   * really is the end" arrive identical, and the closing line would print
   * under the first fifty turns of every truncated session.
   */
  exhausted: boolean;
  /** What the LAST read fell short by. Replacement, not accumulation: every
   * page of one session re-reads the same file the same way, so a later page
   * restates that truth rather than adding to it. */
  shortfall: Shortfall[] | undefined;
  /** The reading refused — set only when the LAST link of the row's union
   * refused too. */
  viewerError: string | null;
  /** A read is in flight; nothing is final yet. */
  loading: boolean;
}

export interface ReadingVerdict {
  /** Sentences that ACCOMPANY what is shown, one per kind, in arrival order. */
  notices: string[];
  /** The one sentence that CLOSES the list, or none. Never joined to the
   * notices: it speaks about the end of the reading, they about its volume. */
  ending: string | null;
}

/**
 * The screen's whole saying, derived from the reading's state.
 *
 * BRANCH ORDER IS THE HIERARCHY OF VERDICTS, and it is the one thing to keep
 * when editing this function. A fact about the READING is answered before a
 * fact about the CONTENT: "we did not read it all" explains why "there are no
 * turns" may be an artefact, so emptiness is subordinate to shortfall and may
 * speak only when the reading was whole.
 */
export function readingVerdict(state: ReadingState): ReadingVerdict {
  const { entries, exhausted, shortfall, viewerError, loading } = state;
  const notices = shortfall === undefined ? [] : shortfall.map(noticeOf);

  // A refusal after turns were shown takes the closing position: the ending
  // says the reading reached the end, this says it broke before it. Printing
  // both would say "we got there and we did not" — and they cannot meet
  // anyway, because `exhausted` latches on the first cause and silences every
  // later read. One condition, read from two sides.
  if (viewerError !== null && entries > 0) {
    return { notices, ending: STOPPED };
  }
  // A refusal before anything was shown is the ROW's verdict, not a sentence
  // about volume: the viewer names it in its own place, with the message.
  if (viewerError !== null) return { notices, ending: null };

  // Nothing is final while a read is in flight — the spinner is the answer.
  if (loading) return { notices, ending: null };

  // Shortfall known, nothing to show. Reachable however the bytes decoded: a
  // capped prefix holding no complete conversation record parses to zero turns
  // with its text fully intact — a session whose first turn is longer than the
  // ceiling gives exactly that.
  if (shortfall !== undefined && entries === 0) {
    return { notices: [], ending: NOTHING_SHOWN };
  }

  // Only HERE may emptiness speak: no shortfall, no refusal, nothing pending.
  if (entries === 0) return { notices, ending: EMPTY };

  // Only an honest end may close the list, and only a byte-measured shortfall
  // HAS an end to point at: a hole among the parts has no place, and the store
  // that reports it cannot say where it sits.
  const closes = exhausted && shortfall?.some((s) => s.kind === "bytes");
  return { notices, ending: closes ? ENDING : null };
}
