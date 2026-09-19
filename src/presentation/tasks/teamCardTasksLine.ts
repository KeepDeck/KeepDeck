import { countByStatus, type Task } from "../../domain/tasks";

/**
 * The card's one line about its board: `4 open · 1 blocked · 2 in review`.
 * Open is what is still to be worked (todo, in progress); blocked and review
 * appear only when they are non-zero, because they are the two states
 * that wait on a person. A board with nothing live but a history says how
 * much is done; a team with no tasks says nothing at all.
 */
export function teamCardTasksLine(tasks: readonly Task[]): string | null {
  const counts = countByStatus(tasks);
  const parts: string[] = [];
  const open = counts.todo + counts["in-progress"];
  if (open > 0) parts.push(`${open} open`);
  if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
  if (counts.review > 0) parts.push(`${counts.review} in review`);
  if (parts.length === 0 && counts.done > 0) parts.push(`${counts.done} done`);
  return parts.length === 0 ? null : parts.join(" · ");
}
