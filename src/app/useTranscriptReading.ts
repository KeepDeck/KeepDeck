import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { AgentTranscriptEntry, Shortfall } from "@keepdeck/plugin-api";
import type { SessionsBrowserApi } from "./useSessionsBrowser";

/** The first page fills a viewport; later ones top it up. Both are reading
 * policy — how much to ask for — not layout. */
const FIRST_TURNS = 50;
const NEXT_TURNS = 20;

/**
 * Reading one session's transcript, page by page, through the row's union of
 * read links ([F8] browser).
 *
 * A LIFECYCLE, and that is why it lives here rather than in the viewer that
 * renders it: it walks a union of handles, retries on refusal, decides when a
 * reading is finished and when it merely broke, and speaks to a port. A view
 * may hold simple mount-scoped state; retry and lifecycle are not that, and
 * this one had grown to six pieces of state inside a component.
 *
 * What stays with the view is the one thing that IS about the view: when to
 * ask for more. "Near the bottom of the box" is a fact about a box, so the
 * caller decides the moment and this decides everything else.
 */
export interface TranscriptReading {
  /** Turns accumulated across the pages read so far. */
  entries: AgentTranscriptEntry[];
  /** No more pages will come — either the reading finished or it broke. Which
   * of the two is told by `error`, and the pair is what lets a caller tell an
   * honest end from a refused one. */
  exhausted: boolean;
  loading: boolean;
  /** Named only when the LAST link of the union refused too. */
  error: string | null;
  /** What the LAST page's reading fell short by. Replaced, not accumulated:
   * every page of one session re-reads the same file under the same ceiling,
   * so a later page restates that truth rather than adding to it. */
  shortfall: Shortfall[] | undefined;
  /** Ask for the next page. A no-op while one is in flight, once the reading
   * is over, and for the opening page the reading fetches itself. */
  more(): void;
}

export function useTranscriptReading(input: {
  read: SessionsBrowserApi["transcript"];
  agent: string;
  /**
   * What "this opening" IS. A new identity starts the reading over.
   *
   * Not the links: a row reopened after a refusal carries the very same union
   * — the same array, even — and keying on it would leave the failed reading
   * standing, mark and all, with no retry possible. Opening is an act, and
   * the act is what this watches; the caller holds whatever object stands
   * for it.
   */
  opening: object;
  /** The row's read links in TRY ORDER — the journal's path first, the
   * index's reference as the spare. Identity change starts a new reading.
   *
   * THE ONLY source of which handle to ask. The row also carries the link it
   * displays, and the two agree by construction — but reading the first ask
   * from one and the walk from the other left room for them to disagree, and
   * a reading that started outside its own union would have walked past the
   * handle it had just used. */
  links: readonly string[];
  /** Orders answers: a page from an older reading must never land under a
   * newer one. Shared with the surface that opens rows. */
  seq: MutableRefObject<number>;
  /** The ROW's verdict about its handles: every link of the union is marked
   * together, because the first must not read as alive when its spare has
   * just refused too. Kept as a callback — whose row it is, and where that
   * mark is drawn, is not this reading's business. */
  markLinks(links: readonly string[], failed: boolean): void;
}): TranscriptReading {
  const { read, agent, opening, links, seq, markLinks } = input;
  const [entries, setEntries] = useState<AgentTranscriptEntry[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shortfall, setShortfall] = useState<Shortfall[] | undefined>(undefined);

  /** Which link is actually SERVING, and how far the walk has come.
   *
   * The union's fall-through advances a link when one refuses, and that
   * advance used to live only in a recursive argument — so the next page
   * asked the dead link again, refused, and marked every link of the row
   * failed, including the one reading a second earlier. Kept here so it
   * outlives the page that made it. */
  const serving = useRef({ reference: links[0] ?? "", tried: 0 });
  /** The opening page is fetched by the effect below; the caller's first
   * "ask for more" would otherwise race it and fetch page zero twice. */
  const openedFor = useRef<object | null>(null);

  const markLinksRef = useRef(markLinks);
  markLinksRef.current = markLinks;

  const load = useCallback(
    (reference: string, tried: number, from: number) => {
      const at = seq.current;
      const limit = from === 0 ? FIRST_TURNS : NEXT_TURNS;
      setLoading(true);
      void read(agent, reference, from, limit)
        .then((page) => {
          if (seq.current !== at) return;
          const turns = page.entries;
          setEntries((current) => (from === 0 ? turns : [...current, ...turns]));
          setExhausted(turns.length < limit);
          setShortfall(page.shortfall);
          // This link answered, so it is the one to ask next.
          serving.current = { reference, tried };
          // A good page retires the row's failure mark — a link reads.
          markLinksRef.current(links, false);
        })
        .catch((e: unknown) => {
          if (seq.current !== at) return;
          const next = links[tried + 1];
          if (next !== undefined) {
            // A refusal is not yet the row's verdict — a handle of the union
            // remains untried. `tried` advances monotonically, so the walk
            // terminates on the last link however many fall.
            //
            // ANY page, not only the first: the row's verdict may be spoken
            // only once every handle has actually been tried, and a walk that
            // stopped at page zero left the union half-walked.
            //
            // And a fresh link ALWAYS starts at zero, even mid-scroll. The
            // union is two RECORDED strings for one session, and nothing
            // guarantees they name a byte-identical file with the same turn
            // order. Handing the fresh link an offset the old one earned
            // would splice two readings into a conversation that never
            // happened — not a loss, an invention. Re-reading pages already
            // seen is the cheap half of that trade.
            load(next, tried + 1, 0);
            return;
          }
          // The read fell on the LAST link — every handle refused. Exhausted
          // stops the caller from asking again for a link that just refused;
          // a retry comes from a fresh open.
          setError(e instanceof Error ? e.message : String(e));
          setExhausted(true);
          markLinksRef.current(links, true);
        })
        .finally(() => {
          if (seq.current === at) setLoading(false);
        });
    },
    [read, agent, links, seq],
  );

  useEffect(() => {
    openedFor.current = opening;
    setEntries([]);
    setExhausted(false);
    setLoading(false);
    setError(null);
    setShortfall(undefined);
    // A fresh opening walks the union from the top — the previous reading's
    // serving link says nothing about this one, and a reopen after a refusal
    // is exactly the case that must try the first handle again.
    serving.current = { reference: links[0] ?? "", tried: 0 };
    load(links[0] ?? "", 0, 0);
    // `links` rides along with the opening it belongs to; watching it too
    // would restart a live reading whenever the row's array were rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening, load]);

  const more = useCallback(() => {
    if (exhausted || loading) return;
    if (openedFor.current === opening) {
      openedFor.current = null;
      return;
    }
    load(serving.current.reference, serving.current.tried, entries.length);
  }, [exhausted, loading, entries.length, opening, load]);

  return { entries, exhausted, loading, error, shortfall, more };
}
