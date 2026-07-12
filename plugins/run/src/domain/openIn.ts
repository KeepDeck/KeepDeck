/**
 * "Open in" — the Run target directory in a picked application.
 *
 * PROTOTYPE list: the real implementation sources these from the plugin's
 * settings (user-managed, any app the OS can resolve by name); hardcoded here
 * to feel the per-workspace picker in the live app first. A name is what the
 * OS resolves it as — on macOS the `open -a` argument.
 */
export const OPEN_APPS = [
  "Visual Studio Code",
  "IntelliJ IDEA",
  "Finder",
] as const;

export const DEFAULT_OPEN_APP: string = OPEN_APPS[0];

/** Narrow a stored pick back to a known app — storage is schemaless and the
 * list can change between runs; anything unknown falls back to the default. */
export function knownOpenApp(stored: unknown): string {
  return typeof stored === "string" &&
    (OPEN_APPS as readonly string[]).includes(stored)
    ? stored
    : DEFAULT_OPEN_APP;
}
