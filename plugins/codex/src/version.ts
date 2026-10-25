/**
 * Reading the release codex answered `--version` with (SpawnPlanInput.
 * cliVersion, MailReplyInput.cliVersion) against the release a behaviour
 * appeared in. One reading, because the hook schema and the launch flags ask
 * the same question and a second parser would be free to answer it
 * differently.
 */

/** `0.147.0` → `[0, 147, 0]`; anything unparseable → null. Padded to three,
 * so `0.147` and `0.147.0` compare equal rather than one ranking below the
 * other on a missing component. */
function versionParts(version: string | null | undefined): number[] | null {
  if (!version) return null;
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return null;
  return [parts[0], parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Whether `cliVersion` is `release` or later — null when the version is
 * unknown or illegible, so each caller says for itself what no evidence
 * means: the hook schema reads it as current, a launch flag as absent.
 */
export function releasedSince(
  cliVersion: string | null | undefined,
  release: readonly number[],
): boolean | null {
  const parts = versionParts(cliVersion);
  if (!parts) return null;
  // Lexicographic, and it has to short-circuit on the FIRST component that
  // differs: 1.0.0 is newer than 0.147.0 even though its second component is
  // smaller, and a comparison that kept looking would call it older.
  for (let i = 0; i < release.length; i += 1) {
    if (parts[i] !== release[i]) return parts[i] > release[i];
  }
  return true;
}
