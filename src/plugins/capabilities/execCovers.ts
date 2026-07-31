import type { Capability } from "@keepdeck/plugin-api";

/**
 * Whether a declared `exec` capability covers `subject` — the program a
 * session is about to spawn (or the literal `"$SHELL"`, see `gate.ts`, for
 * the user's shell). An entry covers `subject` two ways: an exact string
 * match, or a basename match (declaring `"git"` covers a spawn of
 * `/usr/bin/git` — a manifest author shouldn't have to guess the host's
 * install path).
 *
 * There is no wildcard. `readManifest` rejects a bare `"*"` outright, so an
 * entry meaning "any program" cannot reach this function from a manifest —
 * and honouring one here anyway would only re-open the hole by a second
 * route.
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
        (command) => command === subject || command === base,
      ),
  );
}

/** Last path segment, forward- or backward-slash: manifests declare bare
 * command names, real spawn targets are frequently absolute paths. */
function basename(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index < 0 ? path : path.slice(index + 1);
}
