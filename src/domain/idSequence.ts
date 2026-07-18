/**
 * One past the highest `<prefix>-N` id in the live collection.
 *
 * Gaps below the maximum stay untouched, while removing the maximum makes
 * that sequence available again. Non-canonical/imported ids do not
 * participate in the numeric namespace.
 */
export function nextIdSequence(
  ids: readonly string[],
  prefix: string,
): number {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}
