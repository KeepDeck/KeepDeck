/**
 * "Open in" — the Run target directory in an application from the plugin's
 * settings. The list is user-managed (Settings → Run, any app the OS can
 * resolve by name — on macOS the `open -a` argument); each workspace
 * remembers its own pick out of that list.
 */
export const OPEN_APPS_KEY = "openApps";

/** Out of the box the row still opens VS Code — the pre-plugin behavior. */
export const DEFAULT_OPEN_APPS: string[] = ["Visual Studio Code"];

/** Narrow the settings bag's list: strings only, trimmed, no blanks, no
 * duplicates. The host validates against the declared field already; this
 * defends the plugin against a hand-edited settings file all the same. */
export function openAppsFrom(values: Record<string, unknown>): string[] {
  const raw = values[OPEN_APPS_KEY];
  if (!Array.isArray(raw)) return [];
  const apps: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const app = item.trim();
    if (app && !apps.includes(app)) apps.push(app);
  }
  return apps;
}

/** The workspace's effective app: its stored pick while the list still has
 * it, else the list's first entry; `null` when nothing is configured — the
 * "Open in" row hides entirely. */
export function resolveOpenApp(pick: unknown, apps: string[]): string | null {
  if (typeof pick === "string" && apps.includes(pick)) return pick;
  return apps[0] ?? null;
}
