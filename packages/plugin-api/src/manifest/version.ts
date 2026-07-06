/**
 * The plugin API's own version — the value a manifest's `minApiVersion` is
 * checked against at load time. Independent of the app version: the app moves
 * every merge, the API moves only when the contract changes. Unstable parts
 * of the contract carry an `experimental` marker in their name instead of a
 * separate v-next package (the opencode convention), so a plugin's floor
 * stays meaningful across app releases.
 */
export const API_VERSION = "0.0.2";

/**
 * Whether an API at `apiVersion` satisfies a manifest's `minApiVersion`
 * floor. Plain numeric `major.minor.patch` comparison — no ranges, no
 * prerelease grammar: a floor is the one versioning concept plugins need
 * (the Obsidian model). Fails CLOSED: any unparsable version → `false`, so a
 * malformed manifest can never slip past the gate.
 */
export function satisfiesApiFloor(
  minApiVersion: string,
  apiVersion: string = API_VERSION,
): boolean {
  const floor = parseVersion(minApiVersion);
  const api = parseVersion(apiVersion);
  if (!floor || !api) return false;
  for (let i = 0; i < 3; i++) {
    if (api[i] > floor[i]) return true;
    if (api[i] < floor[i]) return false;
  }
  return true;
}

/** `major.minor.patch`, all numeric — anything else is not a version. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
