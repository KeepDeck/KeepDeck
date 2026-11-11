import { usageSessionKey, type UsageRow } from "../history/event";
import { NO_TEAM_HISTORY, teamKey, type TeamHistory } from "./teams";

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
      return teamKey(row, teams);
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
