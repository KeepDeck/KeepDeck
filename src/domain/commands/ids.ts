/** A command id is dot-separated namespace segments: `agent.spawn`,
 * `run.launch`, `keepdeck.voice.listen`. Each segment starts lowercase;
 * camelCase and hyphens are allowed after the first character (plugin ids
 * like `dev.example-preview` become namespaces verbatim). At least two
 * segments — a bare name would collide across contributors, and the first
 * segment IS the owner's namespace (core sets like `agent.*`, a plugin's
 * own id). */
const SEGMENT = /^[a-z][a-zA-Z0-9-]*$/;

export function isValidCommandId(id: string): boolean {
  const segments = id.split(".");
  if (segments.length < 2) return false;
  return segments.every((s) => SEGMENT.test(s));
}

/** An execute-permission pattern: an exact command id, or a namespace prefix
 * with a trailing wildcard (`agent.*` covers `agent.spawn` but also
 * `agent.x.y` — the wildcard spans the rest of the id, matching how consent
 * is granted per-owner, not per-depth). `*` alone is not a valid pattern:
 * all-commands access must be spelled as explicit namespaces so consent can
 * show what it actually covers. */
export function isValidCommandPattern(pattern: string): boolean {
  if (pattern.endsWith(".*")) return isValidCommandId(pattern.slice(0, -2) + ".x");
  return isValidCommandId(pattern);
}

export function matchesPattern(pattern: string, id: string): boolean {
  if (pattern.endsWith(".*")) return id.startsWith(pattern.slice(0, -1));
  return pattern === id;
}

export function matchesAnyPattern(patterns: string[], id: string): boolean {
  return patterns.some((p) => matchesPattern(p, id));
}
