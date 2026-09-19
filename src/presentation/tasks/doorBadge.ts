import type { BoardState } from "../../app/tasks/tasksService";
import { attentionCount } from "../../domain/tasks";

/** What the door shows beside its glyph: how many tasks wait on a person
 * — blocked or in review — across the workspace, or nothing at zero. */
export function tasksDoorBadge(state: BoardState | null): number {
  return state?.kind === "ready" ? attentionCount(state.board.tasks) : 0;
}
