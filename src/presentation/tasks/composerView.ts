/**
 * The two places a person types into the board — the comment composer
 * and the new-task form — decided apart from the markup: whether what
 * they typed may be sent, by the domain's own rule, never by a second
 * copy of it.
 */
import { commentProblem, titleProblem } from "../../domain/tasks";

/** Whether a comment draft may be sent now. */
export function canSendComment(draft: string, sending: boolean): boolean {
  return !sending && commentProblem(draft) === null;
}

/** Whether a new task with this title may be created. */
export function canCreateTask(title: string): boolean {
  return titleProblem(title) === null;
}
