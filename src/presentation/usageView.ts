import { formatAge, type UsageLevel } from "../domain/usage";

/**
 * Presentation rules every usage surface shares — the top-bar panel, the
 * chips and the Stats Providers cards. One owner each, so the surfaces
 * cannot drift apart.
 */

/** The class that colours a reading by its level: amber or red near a
 * limit, none while calm. */
export function usageLevelClass(level: Exclude<UsageLevel, "ok"> | null | undefined): string | undefined {
  return level ? `usage-level--${level}` : undefined;
}

/** How long ago an account last reported: "Updated 5m ago". */
export function reportedAgeCaption(reportedAt: number, now: number): string {
  return `Updated ${formatAge(reportedAt, now)}`;
}
