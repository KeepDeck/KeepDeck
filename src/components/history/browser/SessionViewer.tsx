import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { AgentTranscriptEntry, Shortfall } from "@keepdeck/plugin-api";
import type { AgentInfo } from "../../../domain/agents";
import type { SessionsBrowserApi } from "../../../app/useSessionsBrowser";
import type { UnifiedSessionRow } from "../../../domain/journal";
import { BackIcon } from "../../../ui/icons";
import { NEAR_END } from "../../../ui/useScrollPaging";
import { dirPresent } from "../useDirPresence";
import { SessionRowActions } from "../SessionRowView";
import { readingVerdict } from "./verdictText";

const FIRST_TURNS = 50;
const NEXT_TURNS = 20;

/** What the transcript viewer reads — one row's read link, whichever list
 * the row came from (a journal row or an index hit). Carries the row
 * itself: the header's actions render from the SAME availability rules
 * as the list row, not a re-derivation. */
export interface ViewerTarget {
  agent: string;
  sessionId: string;
  reference: string;
  title: string | null;
  /** The row's read links in try order (the join's union: journal path
   * first, the index's reference as the spare), plus how many have
   * already refused. A failed page zero advances one link; the LAST
   * link's failure is the row's failure. Singleton for hit rows. */
  fallbacks: string[];
  tried: number;
  /** The row this target was opened from — the header's actions live
   * on it (one rule source with the list row). */
  row: UnifiedSessionRow;
}

export interface SessionViewerProps {
  target: ViewerTarget;
  api: Pick<SessionsBrowserApi, "transcript">;
  agents: AgentInfo[];
  presence: ReadonlyMap<string, boolean>;
  readFailed: Dispatch<SetStateAction<ReadonlySet<string>>>;
  viewSeq: MutableRefObject<number>;
  onClose(): void;
  onResume(row: UnifiedSessionRow): void;
  onFork(row: UnifiedSessionRow): void;
}

/**
 * NAMED DEBT, not this item's to pay: this component owns a READ LIFECYCLE.
 *
 * Paging, the walk of the row's link union with its refusal counter, the
 * scroll threshold that decides when to ask for more — a view is allowed
 * simple mount-scoped presentation state, and this is none of those. It
 * arrived whole when the viewer was extracted, so the category is not new;
 * but the honesty work below grew it from four pieces of state to six
 * (`entries`, `exhausted`, `loadingPage`, `viewerError`, `shortfall`,
 * `serving`), and growth without a home is what makes the NEXT edit here more
 * expensive than this one was.
 *
 * The cure is a hook that owns the reading and hands this component turns and
 * a verdict — a subject of its own, larger than "a truncated read says so",
 * and taken deliberately rather than smuggled in beside it. The choice of
 * words below is already out (`verdictText`): a pure function, tested away
 * from the render. That is the shape the rest should follow.
 */
export function SessionViewer({
  target,
  api,
  agents,
  presence,
  readFailed: setReadFailed,
  viewSeq,
  onClose,
  onResume,
  onFork,
}: SessionViewerProps) {
  const [entries, setEntries] = useState<AgentTranscriptEntry[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  /** The viewer's own failure line — a refused read is named where it
   * happened, not rendered as an empty transcript. */
  const [viewerError, setViewerError] = useState<string | null>(null);
  /** What the LAST page's reading fell short by. Replaced, not accumulated:
   * every page of one session re-reads the same file under the same ceiling,
   * so a later page restates that truth rather than adding to it. */
  const [shortfall, setShortfall] = useState<Shortfall[] | undefined>(undefined);
  /** The link that is actually SERVING this session.
   *
   * The union's fall-through advances a link when page zero refuses, and that
   * advance used to live only in the recursive argument — so the next page
   * asked the dead link again, refused, and marked every link of the row
   * failed, including the one reading a second earlier. Silent while nothing
   * was said about it; once the viewer SAYS "the rest did not arrive", the
   * same bug becomes a spoken untruth. The advance is kept here so it outlives
   * the page that made it. */
  const serving = useRef<ViewerTarget>(target);

  /** One transcript read of `target` at `from`. A page-zero refusal falls
   * through to the row's NEXT read link (the union is a real fallback, not
   * a display priority): both links are opaque handles the row merely
   * carries — one can refuse while the other still serves the read. The
   * failure mark lands only when the LAST link refused too. */
  const loadMore = (currentTarget: ViewerTarget, from: number) => {
    const seq = viewSeq.current;
    const limit = from === 0 ? FIRST_TURNS : NEXT_TURNS;
    setLoadingPage(true);
    void api
      .transcript(currentTarget.agent, currentTarget.reference, from, limit)
      .then((page) => {
        if (viewSeq.current !== seq) return;
        const turns = page.entries;
        setEntries((current) => (from === 0 ? turns : [...current, ...turns]));
        setExhausted(turns.length < limit);
        // What THIS reading fell short by, said by `readingVerdict` below.
        setShortfall(page.shortfall);
        // This link answered, so it is the one to ask next — the advance made
        // by a fall-through must outlive the page that made it.
        serving.current = currentTarget;
        // A good page retires the row's failure mark — a link reads.
        for (const link of currentTarget.fallbacks) {
          setReadFailed((current) => {
            if (!current.has(link)) return current;
            const next = new Set(current);
            next.delete(link);
            return next;
          });
        }
      })
      .catch((e: unknown) => {
        if (viewSeq.current !== seq) return;
        const next = currentTarget.fallbacks[currentTarget.tried + 1];
        if (next !== undefined) {
          // The refusal itself is not yet the row's verdict — a link of the
          // union remains untried. Advance one and retry THE SAME page;
          // the viewer stays on the same row, so no state is reset.
          // `tried` advances monotonically: each refusal moves the cursor
          // past the link that refused, so the walk terminates on the
          // last link however many fall.
          //
          // Any page, not only the first: the row's verdict — and now the
          // viewer's sentence "the rest did not arrive" — may be spoken only
          // once every handle has actually been tried. Limiting the walk to
          // page zero left the union half-walked and the sentence untrue.
          //
          // And a new link ALWAYS starts at zero, even mid-scroll. The union
          // is two RECORDED strings for one session — the journal's path and
          // the index's reference — and nothing anywhere guarantees they name
          // a byte-identical file with the same turn order. Handing the fresh
          // link an offset earned by the old one would splice two readings
          // into a conversation that never happened: not a loss, an invention,
          // and worse than anything else this stage is here to stop. Re-reading
          // pages the user has already seen is the cheap half of that trade.
          loadMore({ ...currentTarget, reference: next, tried: currentTarget.tried + 1 }, 0);
          return;
        }
        // The read fell on the LAST link — every handle the row carries
        // refused its attempt. Named as itself, on the viewer AND on the
        // row; the row keeps its place. The mark is the ROW's verdict, so
        // it lands on every link
        // of the union: the first link alone must not read as alive when
        // its spare just refused too. Exhausted stops the viewer's fill-
        // the-viewport effect from re-requesting a link that just
        // refused — a retry comes from a fresh open.
        setViewerError(e instanceof Error ? e.message : String(e));
        setExhausted(true);
        setReadFailed((current) => {
          const nextState = new Set(current);
          for (const link of currentTarget.fallbacks) nextState.add(link);
          return nextState;
        });
      })
      .finally(() => {
        if (viewSeq.current === seq) setLoadingPage(false);
      });
  };

  const openingTargetRef = useRef<ViewerTarget | null>(null);
  useEffect(() => {
    openingTargetRef.current = target;
    setEntries([]);
    setExhausted(false);
    setLoadingPage(false);
    setViewerError(null);
    setShortfall(undefined);
    // A new row starts its walk of the union from the top — the previous
    // row's serving link says nothing about this one.
    serving.current = target;
    loadMore(target, 0);
    // The target changes only when a new row is opened; the sequence ref
    // keeps an earlier response from landing during the replacement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const verdict = readingVerdict({
    entries: entries.length,
    exhausted,
    shortfall,
    viewerError,
    loading: loadingPage,
  });

  // The transcript pages on scroll too (fill-then-increment, [F8]): nearing
  // the bottom fetches the next page; the mount-time check below keeps
  // filling while the loaded turns are shorter than the viewer.
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const maybeLoadPage = useCallback(() => {
    // loadingPage doubles as the in-flight guard: a scroll storm must not
    // fetch the same offset twice nor skip a page.
    if (exhausted || loadingPage) return;
    if (openingTargetRef.current === target) {
      openingTargetRef.current = null;
      return;
    }
    const body = viewerRef.current;
    if (body && body.scrollHeight - body.scrollTop - body.clientHeight < NEAR_END) {
      // The SERVING link, not the row's first one: page zero may have walked
      // past a dead handle to get here, and asking the dead one again would
      // condemn a link that reads.
      loadMore(serving.current, entries.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exhausted, loadingPage, entries.length, target]);
  useEffect(() => {
    maybeLoadPage();
  }, [maybeLoadPage]);

  return (
    <div className="browser__viewer" role="dialog" aria-label="Session transcript">
      {/* A BAR, not one button: the git plugin's drill-back idiom on
       * the left (chevron + label, its own button, same clip and
       * tooltips as before — backing out of a drill-in is
       * navigation), the row's OWN actions on the right. Same
       * availability rules as the list row, read from the same
       * place — a button inside a button is not an option. */}
      <div className="browser__viewerbar">
        <button
          type="button"
          className="browser__back"
          onClick={onClose}
          title="Back to the sessions list"
          aria-label="Back to the sessions list"
        >
          <BackIcon />
          <span className="browser__backlabel">
            {target.title ?? target.sessionId}
          </span>
        </button>
        <SessionRowActions
          row={target.row}
          agents={agents}
          dirMissing={
            target.row.cwd !== "" && !dirPresent(presence, target.row.cwd)
          }
          onResume={onResume}
          onFork={onFork}
        />
      </div>
      <div
        className="browser__viewer-body"
        ref={viewerRef}
        onScroll={maybeLoadPage}
      >
        {entries.map((entry, index) => (
          <div
            key={index}
            className={`browser__turn browser__turn--${entry.role}`}
          >
            {entry.text}
          </div>
        ))}
        {viewerError !== null && entries.length === 0 && (
          // The read fell before anything appeared — named where it happened,
          // never disguised as an empty transcript. Its twin, for a refusal
          // AFTER turns were shown, is the verdict's `ending`: the pair is
          // told apart by what was shown, not by cause.
          <div className="browser__empty">Read failed: {viewerError}</div>
        )}
        {/* What this reading fell short by, one line per kind — listed, never
         * joined. The verdict decides which sentences may speak at all; the
         * order of its branches is the hierarchy, and emptiness comes last
         * because "we did not read it all" explains why "there are no turns"
         * might be an artefact. */}
        {verdict.notices.map((line) => (
          <div key={line} className="browser__verdict">
            {line}
          </div>
        ))}
        {verdict.ending !== null && (
          <div className="browser__verdict browser__verdict--end">
            {verdict.ending}
          </div>
        )}
        {loadingPage && (
          <div className="browser__more" aria-label="Loading transcript">
            <span className="browser__spinner" />
          </div>
        )}
      </div>
    </div>
  );
}
