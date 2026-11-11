import type { JournalRecords } from "../../journal/sessionLog";
import { usageSessionKey, type UsageRow } from "../history/event";

/**
 * Which KeepDeck team a usage row belongs to — THE one chain, from the
 * surest source down:
 * - recorded: the team the row was booked under (capture records it);
 * - journal: the team the session journal bound the session to — the team
 *   at the session's LAST binding, a name only;
 * - branch: the team the journal last saw on the row's worktree branch AT
 *   THE ROW'S TIME — branches are recycled by successive teams, so the
 *   branch's current holder would fold every earlier team into today's;
 * - unknown.
 * The two inferred steps only answer for history booked before teams were
 * recorded; they shrink as recorded rows take over.
 */

export type TeamSource = "recorded" | "journal" | "branch" | "unknown";

export interface RowTeam {
  /** The team's name, null when unknown. */
  name: string | null;
  source: TeamSource;
}

/** What the session journal says about teams, read once per journal change. */
export interface TeamHistory {
  /** Team name by agent session, at its last binding. */
  bySession: ReadonlyMap<string, string>;
  /** Per worktree branch, the teams bound on it over time, oldest first. */
  byBranch: ReadonlyMap<string, readonly { at: number; team: string }[]>;
}

export const NO_TEAM_HISTORY: TeamHistory = { bySession: new Map(), byBranch: new Map() };

export function teamHistory(journal: JournalRecords): TeamHistory {
  const bySession = new Map<string, string>();
  const byBranch = new Map<string, { at: number; team: string }[]>();
  for (const records of Object.values(journal)) {
    for (const record of records) {
      if (record.team === undefined) continue;
      bySession.set(usageSessionKey(record), record.team);
      if (record.branch === undefined) continue;
      const at = Date.parse(record.boundAt);
      if (!Number.isFinite(at)) continue;
      const holders = byBranch.get(record.branch) ?? [];
      holders.push({ at, team: record.team });
      byBranch.set(record.branch, holders);
    }
  }
  for (const holders of byBranch.values()) holders.sort((left, right) => left.at - right.at);
  return { bySession, byBranch };
}

export function rowTeam(row: UsageRow, history: TeamHistory): RowTeam {
  if (row.team !== undefined) return { name: row.team.name, source: "recorded" };
  const named = history.bySession.get(usageSessionKey(row));
  if (named !== undefined) return { name: named, source: "journal" };
  const holder = holderAt(history.byBranch.get(row.worktree?.branch ?? ""), row.occurredAt);
  if (holder !== null) return { name: holder, source: "branch" };
  return { name: null, source: "unknown" };
}

/** The team bound on a branch last before `at` — none before its first. */
function holderAt(holders: readonly { at: number; team: string }[] | undefined, at: number): string | null {
  let holder: string | null = null;
  for (const entry of holders ?? []) {
    if (entry.at > at) break;
    holder = entry.team;
  }
  return holder;
}
