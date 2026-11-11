import { usageSessionKey, type UsageRow } from "../history/event";
import { NO_TEAM_HISTORY, rowTeam, type TeamHistory } from "./teams";

/**
 * What a Statistics breakdown can group by — and THE one key rule per
 * dimension. Keys only: what a group is CALLED is presentation's, read off
 * the group's newest row.
 */
export type StatsDimension = "workspace" | "team" | "agent" | "model" | "session";

/** `teams` is what the session journal says — only the team dimension
 * reads it. */
export function dimensionKey(dimension: StatsDimension, row: UsageRow, teams: TeamHistory = NO_TEAM_HISTORY): string {
  switch (dimension) {
    case "workspace":
      // By name: a workspace id is a reusable slot, the name is what the
      // reader recognises.
      return row.workspaceName;
    case "team":
      // A team's name is only unique inside its workspace; an unknown team
      // is one group per workspace.
      return `${row.workspaceName}\0${rowTeam(row, teams).name ?? ""}`;
    case "agent":
      return row.agent;
    case "model":
      // The booked key carries its provider, so two providers serving one
      // model stay two groups; the agent keeps two CLIs on one key apart.
      return `${row.agent}\0${row.model ?? ""}`;
    case "session":
      return usageSessionKey(row);
  }
}
