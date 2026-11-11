/** Run a body in a FIXED zone, whatever the runner is in. Node re-reads
 * `process.env.TZ` for each Date operation, so this genuinely pins a real
 * transition rather than hoping CI happens to sit in a zone that has one. */
export function inZone(tz: string, body: () => void): void {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    body();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}
