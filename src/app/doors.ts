/**
 * Whether the top bar offers a control at all — three doors, each a policy
 * about the app's state rather than about the bar's markup, named for the
 * reason `artifactsDoorOpen` is: a door has more than one call site in it
 * (the toolbar today; a hotkey, a command, a notification's deep link next),
 * and a second site spelling the check itself is a second source of truth
 * for one rule — one that forgets it opens a door the rule keeps shut.
 *
 * Each answers from what it is handed, never from the store: the composition
 * root already holds these facts, and a door that reached for them itself
 * would be a door that could not be asked in a test.
 */
import { memberRefusal, type Workspace } from "../domain/deck";
import type { NotificationsMode } from "../domain/settings";

/** A team is born inside a workspace, with its directory and its first
 * agent. With none live there is nowhere to put it. */
export function addTeamDoorOpen(active: Workspace | null): boolean {
  return active !== null;
}

/** Whether a member can be added to `teamId` now, and why not when it is
 * refused for a reason the person can act on. The ONE door the bar's
 * «+ Member», a card's "Add member" and ⌘T all open: a full team is
 * refused in words (the cap's own message); a dialog owning the modal layer
 * refuses silently — nothing is wrong, the person is busy elsewhere. */
export function memberDoor(
  ws: Pick<Workspace, "panes">,
  teamId: string,
  modalOpen: boolean,
): { open: boolean; refusal: string | null } {
  const refusal = memberRefusal(ws, teamId);
  return { open: refusal === null && !modalOpen, refusal };
}

/** The dock toggle opens onto the tabs plugins contribute. With none, the
 * door leads into an empty panel — so there is no door. */
export function dockDoorOpen(contributedTabs: number): boolean {
  return contributedTabs > 0;
}

/** The bell is the app's own notification surface. Off is off; and in
 * system mode the OS carries the banners and keeps the history, so a bell
 * would ring over an empty list. Both other modes keep an in-app list the
 * bell opens. */
export function bellDoorOpen(prefs: {
  enabled: boolean;
  mode: NotificationsMode;
}): boolean {
  return prefs.enabled && prefs.mode !== "system";
}
