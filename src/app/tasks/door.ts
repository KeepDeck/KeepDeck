import type { Settings } from "../../domain/settings";

/**
 * Whether this app offers a way into the task board — the artifacts door's
 * rule, for the same reasons: ONE home for the check (the bar today, a
 * notification's deep link, a hotkey tomorrow), the SETTING alone (a
 * failed enable is a thing the dialog tells in the store's own words, not
 * a door that vanishes), and no door before the settings have loaded.
 */
export function tasksDoorOpen(settings: Settings | null): boolean {
  return settings?.tasks === true;
}
