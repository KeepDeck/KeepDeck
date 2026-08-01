/** The numeric guard the ledger's wire format is phrased in: token counters
 * and costs are finite, non-negative numbers or absent — never anything
 * else. Package-internal to history/ — TypeScript has no package-private,
 * so this module's location IS the visibility statement: nothing outside
 * the folder should couple presentation or plugin surfaces to the wire
 * rules. */
export function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
