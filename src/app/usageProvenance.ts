/** Validate host usage provenance without teaching application state any
 * agent schema. Strings are event ISO times; numbers are unix milliseconds.
 * A source cannot honestly postdate its receipt — rejecting future values
 * prevents a skewed session file from poisoning freshest-wins indefinitely. */
export function usageSourceTimestamp(
  value: unknown,
  receivedAt: number,
): number | null {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    parsed = Date.parse(value);
  } else {
    return null;
  }
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= receivedAt
    ? parsed
    : null;
}
