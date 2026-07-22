/**
 * Changelog entries between an installed version and an available update.
 *
 * The release channel publishes a versioned `changelog.json` — one entry per
 * published release — and the updater fetches it alongside `latest.json`. This
 * module owns the PURE selection of which entries a user on `currentVersion`
 * moving to `targetVersion` should see: every release STRICTLY AFTER the
 * installed one and UP TO AND INCLUDING the target. That is the accumulated
 * delta across any number of skipped releases — the whole reason a separate
 * changelog exists instead of the single-version `notes` baked into
 * `latest.json`.
 *
 * Versions are KeepDeck's dotted numerics ("0.16.10"); comparison is numeric
 * per segment. Nothing here touches the network, disk, or React.
 */

export interface ChangelogEntry {
  version: string;
  notes: string;
  /** ISO date the release was published, when the channel provides it. */
  date?: string;
}

/**
 * Numeric compare of two dotted versions, returning a sign like `compareTo`
 * (`<0`, `0`, `>0`). Pure-integer segments compare as integers (BigInt, so an
 * absurdly long segment can't overflow or lose precision); anything else
 * (pre-release tags, suffixes) falls back to a stable string order so the
 * function total-orders instead of mis-ranking a shape it can't fully parse.
 */
export function compareVersions(a: string, b: string): number {
  const aa = a.split(".");
  const bb = b.split(".");
  const last = Math.max(aa.length, bb.length);
  for (let i = 0; i < last; i++) {
    const cmp = compareSegments(aa[i] ?? "0", bb[i] ?? "0");
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function compareSegments(x: string, y: string): number {
  if (INTEGER.test(x) && INTEGER.test(y)) {
    const bx = BigInt(x);
    const by = BigInt(y);
    return bx < by ? -1 : bx > by ? 1 : 0;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

const INTEGER = /^\d+$/;

/**
 * The entries a user on `currentVersion` should see when moving to
 * `targetVersion`: every release `currentVersion < v <= targetVersion`, sorted
 * oldest-first so the result reads as a narrative of what changed since the
 * installed build. Handles an arbitrary gap — a user several releases behind
 * sees every intermediate release, not just the latest. Input order does not
 * matter (the channel ships newest-first; this function does not rely on it),
 * and duplicate versions collapse to their first occurrence.
 */
export function sliceChangelog(
  entries: readonly ChangelogEntry[],
  currentVersion: string,
  targetVersion: string,
): ChangelogEntry[] {
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      if (seen.has(entry.version)) return false;
      seen.add(entry.version);
      return (
        compareVersions(entry.version, currentVersion) > 0 &&
        compareVersions(entry.version, targetVersion) <= 0
      );
    })
    .sort((a, b) => compareVersions(a.version, b.version));
}
