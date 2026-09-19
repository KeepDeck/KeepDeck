/** The Tasks settings row's one decision: when to say the socket is down
 * — only while the feature is on and the socket is not. Agents reach the
 * board through the socket; the dialog does not. */
export function showTasksSocketHint(tasks: boolean, socketUp: boolean): boolean {
  return tasks && !socketUp;
}

/** What the row says while an Off is refused over unsaved boards: the
 * reason, and that the Off completes on its own. Null when nothing is. */
export function offWaitingHint(blockedBy: string | null): string | null {
  if (blockedBy === null) return null;
  return `Off is waiting: ${blockedBy}. The board keeps the changes and retries on its own; Off completes once they are saved.`;
}
