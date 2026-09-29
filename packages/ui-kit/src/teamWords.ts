/* Words about a teammate, shared by every surface that names one — the
   team badge, the tray's hover details, the pane header's role — so they
   cannot phrase the same fact two ways. Pure: no React, safe for a host
   presentation object to import. */

/** One wording for the team badge wherever it stands. */
export function teamBadgeTitle(team: string, role: string): string {
  return `${role} on team ${team} — teammates address it by this role`;
}
