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

/** [`inZone`] for a body that awaits — the zone holds until it settles. */
export async function inZoneAsync(tz: string, body: () => Promise<void>): Promise<void> {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    await body();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}
