/**
 * One past the highest `<prefix>-N` id in the live collection.
 *
 * Gaps below the maximum stay untouched, while removing the maximum makes
 * that sequence available again. Non-canonical/imported ids do not
 * participate in the numeric namespace. Returns `null` when the next value
 * would no longer be represented exactly by JavaScript numbers.
 */
export function nextIdSequence(
  ids: readonly string[],
  prefix: string,
): number | null {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0n;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match) {
      const sequence = BigInt(match[1]);
      if (sequence > max) max = sequence;
    }
  }
  const next = max + 1n;
  return next <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(next) : null;
}
