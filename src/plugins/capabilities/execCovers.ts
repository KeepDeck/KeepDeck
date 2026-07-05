import type { Capability } from "@keepdeck/plugin-api";

/**
 * Whether a declared `exec` capability covers `subject` — the program a
 * session is about to spawn (or the literal `"$SHELL"`, see `gate.ts`, for
 * the user's shell). An entry covers `subject` three ways: an exact string
 * match, a basename match (declaring `"git"` covers a spawn of
 * `/usr/bin/git` — a manifest author shouldn't have to guess the host's
 * install path), or the `"*"` wildcard, which covers anything by design
 * (reserved for built-ins by convention; this function does not special-case
 * or restrict it — that judgment lives at consent time, not here).
 *
 * Exported standalone (not folded into the gate) because the consent UI
 * needs the exact same rule to preview, at install time, what a capability
 * declaration will actually let through.
 */
export function execCovers(capabilities: Capability[], subject: string): boolean {
  const base = basename(subject);
  return capabilities.some(
    (capability) =>
      capability.kind === "exec" &&
      capability.commands.some(
        (command) => command === "*" || command === subject || command === base,
      ),
  );
}

/** Last path segment, forward- or backward-slash: manifests declare bare
 * command names, real spawn targets are frequently absolute paths. */
function basename(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index < 0 ? path : path.slice(index + 1);
}
