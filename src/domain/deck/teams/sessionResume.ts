import type { ResumeBlock } from "../../agents";
import { journalRows, type JournalRecords, type SessionRecord } from "../../journal";
import { normalizePath } from "./lifecycle";

/** What is known about a session when somebody asks to resume it. */
export interface ResumeFacts {
  /** Its recorded directory; "" when it never recorded one. */
  cwd: string;
  /** A pane in the deck holds it. */
  claimed: boolean;
  /** A process outside the deck holds it. */
  busyOutside: boolean;
  /** Its recorded directory still exists. */
  dirPresent: boolean;
}

/**
 * Why the session cannot be resumed onto `team`, or null when it can — THE
 * rule, for every surface that offers a resume.
 *
 * A resume runs where the session was recorded, and a member runs where its
 * team runs: a session recorded in another directory would land on another
 * team, and one on a team whose directory is not there yet has nowhere to
 * run. Forking a copy INTO the team is what those are for. "The same
 * directory" is the deck's key, not the raw strings: the journal records
 * "/repo/wt/" where the team holds "/repo/wt". `team` null: no team is
 * asking.
 */
export function resumeBlock(
  facts: ResumeFacts,
  team: { cwd: string | null } | null,
): ResumeBlock {
  if (facts.cwd === "") return "no-cwd";
  if (facts.claimed) return "claimed";
  if (facts.busyOutside) return "busy-outside";
  if (!facts.dirPresent) return "dir-gone";
  if (team && !recordedOnTeam(facts.cwd, team)) return "elsewhere";
  return null;
}

/** Whether a session recorded in `cwd` runs where `team` runs — its
 * directory there, and the same by the deck's key. The part of
 * [`resumeBlock`] a landing re-asks: a surface's answer is only advice. */
export function recordedOnTeam(cwd: string, team: { cwd: string | null }): boolean {
  return team.cwd !== null && cwd !== "" && normalizePath(cwd) === normalizePath(team.cwd);
}

/** The workspace's recorded sessions split by where they ran: `own` in
 * the team's directory — what an empty team's list pins first — and
 * `other` everywhere else, drawn with the rest of the index. None dropped:
 * a record the index does not know is found nowhere else. */
export function teamJournalLanes(
  journal: JournalRecords,
  wsId: string,
  teamCwd: string,
): { own: SessionRecord[]; other: SessionRecord[] } {
  const own: SessionRecord[] = [];
  const other: SessionRecord[] = [];
  for (const record of journalRows(journal, wsId)) {
    (recordedOnTeam(record.cwd, { cwd: teamCwd }) ? own : other).push(record);
  }
  return { own, other };
}
