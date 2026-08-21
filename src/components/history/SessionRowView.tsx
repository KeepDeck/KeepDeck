import { memo, useCallback } from "react";
import { agentSessionCapabilities, type AgentInfo } from "../../domain/agents";
import type { RowStatus, UnifiedSessionRow } from "../../domain/journal";
import { rowKeyOf } from "../../domain/journal/sessionRow";
import { formatAge } from "../../domain/usage/format";
import { AgentGlyph } from "../../ui/AgentGlyph";
import { baseName } from "../../domain/deck";
import type { CSSProperties } from "react";

/** The journal row's status chip — the visible stand-in for everything
 * that keeps a row unopenable. Plain rows carry no chip at all. */
const STATUS_CHIP: Record<
  RowStatus,
  { label: string; title: string; tone?: "error" }
> = {
  "wrong-owner": {
    label: "wrong agent",
    tone: "error",
    title:
      "This session id exists under another agent — the journal recorded the wrong one, so the row cannot be opened or continued here",
  },
  indexing: {
    label: "Indexing…",
    title:
      "The session index is still filling — the row's readability is decided when it answers",
  },
  "nothing-to-read": {
    label: "nothing to read",
    title:
      "The conversation ran here, but no transcript survives in the journal or the index",
  },
  "index-error": {
    label: "index unreachable",
    tone: "error",
    title:
      "The index could not be asked — not a verdict on the session; what was already known still stands",
  },
  // 'read failed' is deliberately NOT here: unlike the states above it is
  // a REACTION to an attempt, not a state knowable in advance. Probing
  // files ahead of the click would cost a stat per row per panel open,
  // to predict a case that announces itself on the first open.
};

export interface SessionRowViewProps {
  row: UnifiedSessionRow;
  agents: AgentInfo[];
  /** The row's NONEMPTY directory no longer exists — blocks Resume in
   * place and paints the chip. An EMPTY cwd is a different absence (no
   * recorded directory): Resume is blocked there too, but nothing is
   * claimed "gone" — there is no path to have vanished. */
  dirMissing: boolean;
  /** The row's last read by link fell — named on the row, as itself. */
  readFailed: boolean;
  /** One clock for the whole list — ages don't tick mid-render. */
  now: number;
  /** The virtual window's top offset for this row, in px (the
   * virtualizer's measured position). The row positions itself;
   * there is no last-row anchor anymore — the paging signal reads
   * the virtual range, not a DOM node. */
  virtualStart?: number;
  /** The row's queue index, stamped as data-index for the
   * virtualizer's measurement pass (measureElement resolves the row
   * by this attribute — the ref callback stays ONE stable function). */
  virtualIndex?: number;
  /** Receives the row's <li> for height measurement by the
   * virtualizer (dynamic heights: wrapped meta lines, future
   * snippets). STABLE by contract: the caller passes ONE function
   * for the whole list, or the row's memo falls. */
  measureRef?: (el: HTMLLIElement | null) => void;
  onOpen(row: UnifiedSessionRow): void;
  onResume(row: UnifiedSessionRow): void;
  onFork(row: UnifiedSessionRow): void;
}

/**
 * The row's action buttons — Resume and Fork — as their OWN unit, so
 * the list row and the opened-session header render them from ONE
 * place: the availability rules (source-aware resume gate, the
 * wrong-owner lockout, the dir gates) live here once and are never
 * re-derived per surface.
 */
export function SessionRowActions({
  row,
  agents,
  dirMissing,
  onResume,
  onFork,
}: {
  row: UnifiedSessionRow;
  agents: AgentInfo[];
  dirMissing: boolean;
  onResume(row: UnifiedSessionRow): void;
  onFork(row: UnifiedSessionRow): void;
}) {
  const {
    resume: supportsResume,
    fork: supportsFork,
  } = agentSessionCapabilities(agents, row.agent);
  const bound = row.kind === "bound" ? row : null;
  const index = row.kind === "index" ? row : null;
  const wrongOwner = bound?.status === "wrong-owner";
  // STABLE per row-object: the row is a memoized composition output,
  // so these closures do not churn across unrelated re-renders.
  const handleResumeClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onResume(row);
    },
    [onResume, row],
  );
  const handleForkClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onFork(row);
    },
    [onFork, row],
  );
  return (
    // ONE group — a single grid cell in the row (and one child of the
    // viewer bar). Two loose buttons would take two cells: the grid's
    // auto-placement dropped the second onto the meta line below. The
    // group keeps its cell even when empty (no button available) or
    // holding one — the row's shape never depends on availability.
    <span className="history__actions">
      {/* The Resume gate, source-aware: a BOUND row resumes unless it is
       * live right now; an INDEX row has no liveness fact AT ALL and
       * resumes — most rows from the other source are exactly this. */}
      {supportsResume &&
      !wrongOwner &&
      (index !== null || bound?.liveness !== "live") && (
        <button
          type="button"
          className="history__resume"
          disabled={dirMissing || row.cwd === ""}
          title={
            dirMissing
              ? "The session's directory no longer exists"
              : row.cwd === ""
                ? "The session has no recorded directory"
                : `Resume in ${row.cwd}`
          }
          onClick={handleResumeClick}
        >
          Resume
        </button>
      )}
      {supportsFork && !wrongOwner && (
        <button
          type="button"
          className="history__fork"
          title="Fork — a new conversation continuing from this session"
          onClick={handleForkClick}
        >
          Fork
        </button>
      )}
    </span>
  );
}

/**
 * The ONE row component both sessions tracks render. The tracks differ
 * by which side of the workspace boundary a session sits on — never by
 * markup: the skeleton (glyph, name+snippet, actions, the meta line) is
 * this component, and a source's silence is an empty meta part, not a
 * different template. The serialization guard in the suite pins that.
 *
 * MEMOIZED on its props: the list renders hundreds of these, and every
 * prop is stable across unrelated re-renders (row objects, action
 * adapters and `now` are memoized upstream) — so a landed page draws
 * its NEW rows and skips the old ones entirely. The memo compares by
 * prop identity; `rowRef` rides a stable ref object, `dirMissing` and
 * `readFailed` are primitives.
 */
export const SessionRowView = memo(function SessionRowView({
  row,
  agents,
  dirMissing,
  readFailed,
  now,
  virtualStart,
  virtualIndex,
  measureRef,
  onOpen,
  onResume,
  onFork,
}: SessionRowViewProps) {
  const agent = agents.find((a) => a.id === row.agent);
  const {
    history: canReadHistory,
  } = agentSessionCapabilities(agents, row.agent);
  // STABLE handlers: `row` is a memoized object (the composition's own
  // output), so these closures survive every unrelated re-render — the
  // memo above then skips this row entirely. (The ACTIONS carry their
  // own stable pair inside SessionRowActions.)
  const handleOpenClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onOpen(row);
    },
    [onOpen, row],
  );
  // Narrowing by the row's OWN source: the verdict chips, the branch and
  // the liveness dot are BOUND-row facts (the journal vouches for them);
  // the snippet is an INDEX-row fact (a content match). Reading each
  // field only inside its variant is the exhaustive half of the union's
  // bargain — the compiler enforces the split the markup always implied.
  const bound = row.kind === "bound" ? row : null;
  const index = row.kind === "index" ? row : null;
  // A wrong-owner row is visible but continuation would feed the wrong
  // plugin — the affordances do not render at all.
  const wrongOwner = bound?.status === "wrong-owner";
  const openable = row.read !== null && canReadHistory && !wrongOwner;
  const statusChip =
    bound === null || bound.status === null ? null : STATUS_CHIP[bound.status];
  // The no-title fallback must DISTINGUISH, not decorate: the agent is
  // already the glyph on the left, and a label fallback makes neighbors
  // twins — the very wall of identical rows this work began with. The
  // session id is ugly but unique: rows stay tellable apart, and a row
  // found once is found again by eye. (A title EQUAL to the agent label
  // is treated as absent upstream, so nothing falls back into it either.)
  const name = row.title ?? row.sessionId;

  // The virtual window's own position for this row: absolute inside the
  // one spacer, top at the measured offset. Outside the virtualized
  // list (nothing does that today, but the prop is optional) the row
  // flows normally.
  const positionStyle: CSSProperties | undefined =
    virtualStart === undefined
      ? undefined
      : {
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          transform: `translateY(${virtualStart}px)`,
        };

  return (
    <li
      key={rowKeyOf(row)}
      ref={measureRef}
      data-index={virtualIndex}
      className={`history__row history__datarow${openable ? " history__row--open" : ""}`}
      style={positionStyle}
      // The WHOLE row opens the transcript — aiming at the text alone is a
      // hidden hit-target. The action buttons stop the bubble; the inner
      // button stays for keyboard access (its synthesized click bubbles
      // here too).
      onClick={openable ? () => onOpen(row) : undefined}
    >
      {/* THREE columns, two rows — the family shape of this app's list
       * rows (bell__item): glyph spans both rows, the name and the
       * actions share the first, the metadata flows under the name at
       * its OWN width. The liveness dot and the branch chip are GONE
       * by the user's direct choice; absence keeps no seat. The meta
       * is one quiet text line — folder, age, then exceptional marks
       * — separated by middots, wrapping WHOLE if crowded. */}
      <span className="history__glyph">
        <AgentGlyph icon={agent?.icon} />
      </span>
      <button
        type="button"
        className="browser__open"
        disabled={!openable}
        title={openable ? "Read this session" : undefined}
        onClick={handleOpenClick}
      >
        <span className="browser__name" title={row.sessionId}>
          {name}
        </span>
        {index !== null && index.snippet !== null && (
          <span className="browser__snippet">{index.snippet}</span>
        )}
      </button>
      {/* The actions — ONE unit shared with the opened-session header. */}
      <SessionRowActions
        row={row}
        agents={agents}
        dirMissing={dirMissing}
        onResume={onResume}
        onFork={onFork}
      />
      <span className="history__meta">
        {row.cwd !== "" && (
          <span className="history__meta-folder" title={row.cwd}>
            {baseName(row.cwd) || row.cwd}
          </span>
        )}
        {row.when !== null && (
          <span className="history__meta-age">{formatAge(row.when, now)}</span>
        )}
        {dirMissing && (
          <span className="history__meta-mark" title={`${row.cwd} no longer exists — the session cannot resume in place`}>
            dir gone
          </span>
        )}
        {statusChip !== null && (
          <span
            className={`history__meta-mark${
              statusChip.tone === "error" ? " history__meta-mark--err" : ""
            }`}
            title={statusChip.title}
          >
            {statusChip.label}
          </span>
        )}
        {readFailed && (
          <span
            className="history__meta-mark history__meta-mark--err"
            title="Reading this session failed. This is not 'nothing to read': the row stays, and a retry is legitimate"
          >
            read failed
          </span>
        )}
      </span>
    </li>
  );
});
