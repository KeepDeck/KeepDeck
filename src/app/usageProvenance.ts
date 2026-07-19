/** Validate host usage provenance without teaching application state any
 * agent schema. The primitive union has one wire field: string is an event
 * ISO time, number is file-mtime unix milliseconds. */
export function usageSourceTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
