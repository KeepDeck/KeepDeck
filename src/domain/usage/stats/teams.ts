import type { JournalRecords } from "../../journal/sessionLog";
import { usageSessionKey, type UsageRow } from "../history/event";

/**
 * Which KeepDeck team a usage row belongs to — THE one chain, from the
 * surest source down:
 * - recorded: capture records the team the row was booked under, or that
 *   its pane was on NO team — a fact, never a gap to infer over;
 * - journal: the team the session journal bound the session to — the team
 *   at the session's LATEST binding, a name only;
 * - branch: the team the journal last saw on the row's worktree branch IN
 *   THE ROW'S OWN WORKSPACE, AT THE ROW'S TIME — branches are recycled by
 *   successive teams, and two workspaces can each have a `feature/x`;
 * - unknown.
 * Only a row booked before teams were recorded is inferred at all; such
 * rows shrink as recorded ones take over.
 */

export type TeamSource = "recorded" | "journal" | "branch";

/** A row's team: a member of a named team, recorded or inferred; on no
 * team, recorded; or unknown. */
export type RowTeam =
  | { kind: "member"; name: string; source: TeamSource }
  | { kind: "none" }
  | { kind: "unknown" };

/** What the session journal says about teams, read once per journal change. */
export interface TeamHistory {
  /** Team name by agent session, at its latest binding anywhere. */
  bySession: ReadonlyMap<string, string>;
  /** Per workspace name and worktree branch, the teams bound on it over
   * time, oldest first. */
  byBranch: ReadonlyMap<string, readonly { at: number; team: string }[]>;
}

export const NO_TEAM_HISTORY: TeamHistory = { bySession: new Map(), byBranch: new Map() };

const branchKey = (workspaceName: string, branch: string) => `${workspaceName}\0${branch}`;

/**
 * The journal's teams. The journal keys its records by workspace SLOT; a
 * row names its workspace, so branches are keyed by the slot's current
 * NAME (`workspaceNames`) — a slot whose workspace has gone has no records
 * left, and a renamed workspace simply finds none, falling to unknown
 * rather than borrowing another's.
 */
export function teamHistory(journal: JournalRecords, workspaceNames: ReadonlyMap<string, string>): TeamHistory {
  const bySession = new Map<string, { at: number; team: string }>();
  const byBranch = new Map<string, { at: number; team: string }[]>();
  for (const [wsId, records] of Object.entries(journal)) {
    const workspace = workspaceNames.get(wsId);
    for (const record of records) {
      if (record.team === undefined) continue;
      const at = Date.parse(record.boundAt);
      if (!Number.isFinite(at)) continue;
      const key = usageSessionKey(record);
      const seen = bySession.get(key);
      if (seen === undefined || seen.at <= at) bySession.set(key, { at, team: record.team });
      if (record.branch === undefined || workspace === undefined) continue;
      const holders = byBranch.get(branchKey(workspace, record.branch)) ?? [];
      holders.push({ at, team: record.team });
      byBranch.set(branchKey(workspace, record.branch), holders);
    }
  }
  for (const holders of byBranch.values()) holders.sort((left, right) => left.at - right.at);
  return { bySession: new Map([...bySession].map(([key, seen]) => [key, seen.team])), byBranch };
}

export function rowTeam(row: UsageRow, history: TeamHistory): RowTeam {
  if (row.team !== undefined) {
    return row.team.kind === "member" ? { kind: "member", name: row.team.name, source: "recorded" } : { kind: "none" };
  }
  const named = history.bySession.get(usageSessionKey(row));
  if (named !== undefined) return { kind: "member", name: named, source: "journal" };
  const branch = row.worktree?.branch;
  const holder = branch === undefined ? null : holderAt(history.byBranch.get(branchKey(row.workspaceName, branch)), row.occurredAt);
  if (holder !== null) return { kind: "member", name: holder, source: "branch" };
  return { kind: "unknown" };
}

/** The key of a row's team group: a team's name is only unique inside its
 * workspace, and "no team" and "unknown" are groups of their own there. */
export function teamKey(row: UsageRow, history: TeamHistory): string {
  const team = rowTeam(row, history);
  const which = team.kind === "member" ? `team\0${team.name}` : team.kind;
  return `${row.workspaceName}\0${which}`;
}

/** How a team group's money is attributed: wholly recorded, wholly
 * inferred, or a mix — read off EVERY row of the group, never one. */
export type TeamProvenance = "recorded" | "inferred" | "mixed";

export function teamProvenance(rows: readonly UsageRow[], history: TeamHistory): Map<string, TeamProvenance> {
  const out = new Map<string, TeamProvenance>();
  for (const row of rows) {
    const team = rowTeam(row, history);
    const here: TeamProvenance = team.kind === "member" && team.source !== "recorded" ? "inferred" : "recorded";
    const key = teamKey(row, history);
    const seen = out.get(key);
    out.set(key, seen === undefined || seen === here ? here : "mixed");
  }
  return out;
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
