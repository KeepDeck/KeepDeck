import { agentSessionCapabilities, type AgentInfo } from "../../domain/agents";
import type { RowStatus, UnifiedSessionRow } from "../../domain/journal";
import { formatAge } from "../../domain/usage/format";
import { AgentGlyph } from "../../ui/AgentGlyph";
import { Chip } from "../../ui/Chip";
import { baseName } from "../../domain/deck";
import type { RefObject } from "react";

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
    label: "indexing…",
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
  // 'read failed' is deliberately NOT here: unlike the four above it is
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
  /** The workspace block's LAST row carries the block's paging anchor. */
  rowRef?: RefObject<HTMLLIElement | null>;
  onOpen(row: UnifiedSessionRow): void;
  onResume(row: UnifiedSessionRow): void;
  onFork(row: UnifiedSessionRow): void;
}

/**
 * The ONE row component both sessions blocks render. The blocks differ by
 * which side of the workspace boundary a session sits on — never by
 * markup: the skeleton (live dot?, glyph, name+snippet, directory, branch?,
 * time, chips?, Resume?, Fork?) is this component, and a source's silence
 * is an empty cell, not a different template. The serialization guard in
 * the suite pins exactly that.
 */
export function SessionRowView({
  row,
  agents,
  dirMissing,
  readFailed,
  now,
  rowRef,
  onOpen,
  onResume,
  onFork,
}: SessionRowViewProps) {
  const agent = agents.find((a) => a.id === row.agent);
  const {
    resume: supportsResume,
    fork: supportsFork,
    history: canReadHistory,
  } = agentSessionCapabilities(agents, row.agent);
  // A wrong-owner row is visible but continuation would feed the wrong
  // plugin — the affordances do not render at all.
  const wrongOwner = row.status === "wrong-owner";
  const openable = row.read !== null && canReadHistory && !wrongOwner;
  const statusChip = row.status === null ? null : STATUS_CHIP[row.status];
  // The no-title fallback must DISTINGUISH, not decorate: the agent is
  // already the glyph on the left, and a label fallback makes neighbors
  // twins — the very wall of identical rows this work began with. The
  // session id is ugly but unique: rows stay tellable apart, and a row
  // found once is found again by eye. (A title EQUAL to the agent label
  // is treated as absent upstream, so nothing falls back into it either.)
  const name = row.title ?? row.sessionId;

  return (
    <li
      key={`${row.agent}:${row.sessionId}`}
      ref={rowRef}
      className={`history__row${openable ? " history__row--open" : ""}`}
      // The WHOLE row opens the transcript — aiming at the text alone is a
      // hidden hit-target. The action buttons stop the bubble; the inner
      // button stays for keyboard access (its synthesized click bubbles
      // here too).
      onClick={openable ? () => onOpen(row) : undefined}
    >
      {row.liveness !== null && (
        <span
          className={`history__state${
            row.liveness === "live" ? " history__state--live" : ""
          }`}
          title={row.liveness === "live" ? "Running" : "Closed"}
        />
      )}
      <span className="history__glyph">
        <AgentGlyph icon={agent?.icon} />
      </span>
      <button
        type="button"
        className="browser__open"
        disabled={!openable}
        title={openable ? "Read this session" : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (openable) onOpen(row);
        }}
      >
        <span className="browser__name" title={row.sessionId}>
          {name}
        </span>
        {row.snippet !== null && (
          <span className="browser__snippet">{row.snippet}</span>
        )}
      </button>
      {row.cwd !== "" && (
        <Chip
          size="inline"
          className="history__chip"
          title={row.cwd}
          label={baseName(row.cwd) || row.cwd}
        />
      )}
      {row.branch !== undefined && (
        <Chip
          size="inline"
          className="history__chip"
          title={row.cwd}
          label={row.branch}
        />
      )}
      <span className="history__when">
        {row.when !== null ? formatAge(row.when, now) : ""}
      </span>
      {dirMissing && (
        <Chip
          size="inline"
          tone="error"
          className="history__missing"
          title={`${row.cwd} no longer exists — the session cannot resume in place`}
          label="dir gone"
        />
      )}
      {statusChip !== null && (
        <Chip
          size="inline"
          tone={statusChip.tone}
          className="history__status"
          title={statusChip.title}
          label={statusChip.label}
        />
      )}
      {readFailed && (
        <Chip
          size="inline"
          tone="error"
          className="history__status"
          title="Reading this session failed — its transcript file disappeared between the scan and the open. This is not 'nothing to read': the row stays, and a retry is legitimate."
          label="read failed"
        />
      )}
      {supportsResume && !wrongOwner && row.liveness !== "live" && (
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
          onClick={(e) => {
            e.stopPropagation();
            onResume(row);
          }}
        >
          Resume
        </button>
      )}
      {supportsFork && !wrongOwner && (
        <button
          type="button"
          className="history__fork"
          title="Fork — a new conversation continuing from this session"
          onClick={(e) => {
            e.stopPropagation();
            onFork(row);
          }}
        >
          Fork
        </button>
      )}
    </li>
  );
}
