/**
 * The artifacts dialog's sentences that do not ride on a view model's
 * arm — one home, so the dialog only places them.
 */

/** Under an open row whose versions are still being read. */
export const HISTORY_LOADING = "Loading…";

/** Under an open row whose read came back empty. */
export const HISTORY_GONE = "No versions — the artifact went while this opened";

/** The delete confirm's question: what goes, said before it goes. */
export function deleteQuestion(title: string): string {
  return `Delete "${title}"? Every version goes, its open pages say goodbye, and the id stops resolving`;
}
