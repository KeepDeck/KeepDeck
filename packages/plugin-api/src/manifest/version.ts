/**
 * The plugin API's own revision — a plain incrementing INTEGER, not semver. It
 * moves by exactly one whenever the contract grows (a new service, a new
 * capability); a plugin's `minApiVersion` is the lowest revision it needs. A
 * single number is all a contract floor is: there is no meaningful major/minor
 * split for "the API got bigger." (Was `major.minor.patch` `0.0.N`; this is N.)
 *
 * Independent of the app version, and independent of `@keepdeck/plugin-api`'s
 * package.json version (that one is just an npm semver so the workspace
 * resolves the package). This is the load-bearing one.
 */
export const API_VERSION = 22; // 22: + staged shared skills (SpawnPlanInput.skills)

/** Oldest contract the current host can execute. Raise only for a breaking change. */
export const MIN_COMPATIBLE_API_VERSION = 21;

/**
 * Whether a manifest's floor falls inside the host's compatibility window.
 * Fails CLOSED — any non-integer (a malformed manifest, a stray `0.0.x` string
 * that slipped the reader) yields `false`, so it can never pass the gate.
 */
export function satisfiesApiFloor(
  minApiVersion: number,
  apiVersion: number = API_VERSION,
  minCompatibleVersion: number = MIN_COMPATIBLE_API_VERSION,
): boolean {
  if (
    !isApiVersion(minApiVersion) ||
    !isApiVersion(apiVersion) ||
    !isApiVersion(minCompatibleVersion)
  ) {
    return false;
  }
  return minApiVersion >= minCompatibleVersion && minApiVersion <= apiVersion;
}

/** A valid API revision: a non-negative integer. */
export function isApiVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** `major.minor.patch`, all numeric — the plugin's OWN version (display and
 * update bookkeeping), which stays semver; anything else is not a version. Not
 * used for the API floor (that's an integer, see `API_VERSION`). */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
