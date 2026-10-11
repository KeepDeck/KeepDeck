/** Whether two id lists name the same ids, in any order — for a list kept
 * as a set, where a reordering is no change. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}
