import type { Settings } from "../../domain/settings";

/**
 * Whether this app offers a way into the artifacts registry.
 *
 * ONE home for the rule, because the door has more than one call site in
 * it: the toolbar today, and whatever opens the registry next — a
 * notification's deep link, a hotkey, a command. A second site spelling
 * the check itself would be a second source of truth for one rule, and
 * one that forgot it would open the registry for a feature the user
 * turned off.
 *
 * The SETTING alone, deliberately. Whether the backend enable actually
 * landed is NOT a gate here: a claim lost to another KeepDeck process is
 * a thing the user has to be told, and the registry tells it in the
 * store's own words. A door that vanished instead would leave them with
 * a setting that reads On and nothing anywhere saying why nothing works.
 *
 * Unsettled settings (`null`, before the first load) mean no door: the
 * app does not yet know what the user chose, and offering the feature on
 * a guess is how a switched-off feature gets opened.
 */
export function artifactsDoorOpen(settings: Settings | null): boolean {
  return settings?.artifacts === true;
}
