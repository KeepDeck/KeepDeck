import { useCallback, useEffect, useRef } from "react";
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { AgentInfo } from "../../../domain/agents";
import type { SessionsBrowserApi } from "../../../app/useSessionsBrowser";
import { useTranscriptReading } from "../../../app/useTranscriptReading";
import type { UnifiedSessionRow } from "../../../domain/journal";
import { BackIcon } from "../../../ui/icons";
import { NEAR_END } from "../../../ui/useScrollPaging";
import { dirPresent } from "../useDirPresence";
import { SessionRowActions } from "../SessionRowView";
import { readingVerdict } from "./verdictText";

/** What the transcript viewer reads — one row's read link, whichever list
 * the row came from (a journal row or an index hit). Carries the row
 * itself: the header's actions render from the SAME availability rules
 * as the list row, not a re-derivation. */
export interface ViewerTarget {
  agent: string;
  sessionId: string;
  title: string | null;
  /** The row's read links in TRY ORDER (the join's union: journal path
   * first, the index's reference as the spare) — the single source of which
   * handle to ask, head included. The row's displayed link used to sit here
   * too, as its own field; it agreed with the head by construction and was
   * read by no one, which is how a field becomes a trap: loaded-looking,
   * dead, and one day read again by someone who reintroduces the split. */
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
 * The transcript surface: it RENDERS a reading and owns nothing of it.
 *
 * The reading itself — paging, the walk of the row's link union, the retry on
 * refusal, when a reading is finished versus merely broken — lives in
 * [`useTranscriptReading`], because that is a lifecycle and a view may not
 * own one. What stays is the pair that is genuinely about this component:
 * WHEN to ask for more (near the bottom of a box is a fact about a box) and
 * how the answer reads on screen. The words are out too, in `verdictText`.
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
  /** The ROW's verdict about its handles: marked together, because the first
   * must not read as alive when its spare has just refused too. */
  const markLinks = useCallback(
    (links: readonly string[], failed: boolean) => {
      setReadFailed((current) => {
        const next = new Set(current);
        for (const link of links) {
          if (failed) next.add(link);
          else next.delete(link);
        }
        return next.size === current.size &&
          [...next].every((link) => current.has(link))
          ? current
          : next;
      });
    },
    [setReadFailed],
  );

  const reading = useTranscriptReading({
    read: api.transcript,
    agent: target.agent,
    // The target IS the opening: a fresh one is minted per row click, so a
    // reopen after a refusal starts a new reading even though the row's links
    // are the very same array.
    opening: target,
    links: target.fallbacks,
    seq: viewSeq,
    markLinks,
  });
  const { entries } = reading;

  const verdict = readingVerdict({
    entries: entries.length,
    exhausted: reading.exhausted,
    shortfall: reading.shortfall,
    viewerError: reading.error,
    loading: reading.loading,
  });

  // WHEN to ask for more is the one part of the reading that is genuinely
  // about this component: "near the bottom of the box" is a fact about a box.
  // The mount-time run keeps filling while the loaded turns are shorter than
  // the viewport (fill-then-increment, [F8]); the reading itself refuses a
  // duplicate ask while a page is in flight.
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const { more } = reading;
  const maybeLoadPage = useCallback(() => {
    const body = viewerRef.current;
    if (body && body.scrollHeight - body.scrollTop - body.clientHeight < NEAR_END) {
      more();
    }
  }, [more]);
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
        {reading.error !== null && entries.length === 0 && (
          // The read fell before anything appeared — named where it happened,
          // never disguised as an empty transcript. Its twin, for a refusal
          // AFTER turns were shown, is the verdict's `ending`: the pair is
          // told apart by what was shown, not by cause.
          <div className="browser__empty">Read failed: {reading.error}</div>
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
        {reading.loading && (
          <div className="browser__more" aria-label="Loading transcript">
            <span className="browser__spinner" />
          </div>
        )}
      </div>
    </div>
  );
}
