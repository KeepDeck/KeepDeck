/**
 * Which team's board the dialog shows. A task the dialog was opened ON
 * (a notification, a deep link) names its own team, and that outranks
 * whatever team was chosen before — a link that landed on the wrong
 * board showed nothing. Otherwise the person's choice, while that team
 * still exists; otherwise the first.
 */
export function teamOnScreen(
  teamIds: readonly string[],
  chosen: string | null,
  focusedTaskTeam: string | null,
): string | null {
  if (focusedTaskTeam !== null && teamIds.includes(focusedTaskTeam)) return focusedTaskTeam;
  if (chosen !== null && teamIds.includes(chosen)) return chosen;
  return teamIds[0] ?? null;
}
