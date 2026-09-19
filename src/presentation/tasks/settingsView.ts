/** The Tasks settings row's one decision: when to say the socket is down
 * — only while the feature is on and the socket is not. Agents reach the
 * board through the socket; the dialog does not. */
export function showTasksSocketHint(tasks: boolean, socketUp: boolean): boolean {
  return tasks && !socketUp;
}
