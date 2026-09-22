/**
 * The artifacts dialog's sentences that carry data — built here so the
 * dialog only places them.
 */

/** A search that found nothing, quoting what was typed. */
export function noMatchTitle(query: string): string {
  return `Nothing matches “${query}”`;
}

/** The delete confirm's question: what goes, said before it goes. */
export function deleteQuestion(title: string): string {
  return `Delete "${title}"? Every version goes, its open pages say goodbye, and the id stops resolving`;
}
