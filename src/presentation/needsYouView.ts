/**
 * What the bell says — its badge and the "Needs you" list in its panel — decided apart from the markup, the [`stripView`] precedent.
 *
 * The list is the deck's answer to "who is blocked on me", across every
 * workspace: an agent waiting for a person, or one whose turn died. Failed
 * rows lead (a dead turn does nothing until someone looks), then waiting;
 * inside each, the longest-blocked first. Working and done agents are not
 * here — the tiles and the tray already say them, and a list of everything
 * is a list of nothing.
 */
import { blockedAgents, paneDisplayTitle, type Workspace } from "../domain/deck";
import { activityBadge, type PaneActivity } from "../domain/status";
import { formatAge } from "../domain/usage";

/** A row's state — one that needs a person (`needsPerson`). */
export type NeedsYouTone = PaneActivity["state"];

/** One agent that is blocked on the person. */
export interface NeedsYouRow {
  wsId: string;
  paneId: string;
  tone: NeedsYouTone;
  /** The agent's name, as its tile says it. */
  title: string;
  /** Where it is: the workspace, its team and its role. */
  where: string;
  /** Why it needs you, in the header's words ("Needs approval"). */
  label: string;
  /** When it became blocked — [`needsYouAge`] words it against the instant
   * the panel opened, so the rows need no clock and the app no tick. */
  since: number;
}

/** What the bar's trigger shows: always the bell, never words — with the
 * unread count where the in-app list is on, else the count of agents that
 * need the person (the only thing its panel then holds); nothing at all
 * when there is neither a list nor anyone waiting. */
export type AttentionTrigger = { badge: string | null; label: string } | null;

/** The blocked agents (domain `blockedAgents`: who, and in what order), in
 * words. */
export function needsYouRows(
  workspaces: readonly Workspace[],
  activities: ReadonlyMap<string, PaneActivity>,
  agents: readonly { id: string; label: string }[],
): NeedsYouRow[] {
  return blockedAgents(workspaces, activities).map(({ ws, pane, index, team, activity, since }) => ({
    wsId: ws.id,
    paneId: pane.id,
    tone: activity.state,
    title: paneDisplayTitle(pane, index, agents),
    where: [ws.name, team.name, pane.team?.role].filter(Boolean).join(" · "),
    label: activityBadge(activity).label,
    since,
  }));
}

/** How long `row`'s agent has been blocked, as of `now` ("4m"). */
export function needsYouAge(row: NeedsYouRow, now: number): string {
  return formatAge(row.since, now, "bare");
}

/** The trigger for `rows`, given whether the in-app notification list is on
 * and how much of it is unread. */
export function attentionTrigger(
  rows: readonly NeedsYouRow[],
  bell: { unread: number } | null,
): AttentionTrigger {
  if (!bell && rows.length === 0) return null;
  const count = bell ? bell.unread : rows.length;
  const label = bell
    ? count > 0
      ? `${ATTENTION_WORDS.notifications} (${count} unread)`
      : ATTENTION_WORDS.notifications
    : `${count === 1 ? "1 agent needs" : `${count} agents need`} you`;
  return { badge: count > 0 ? (count > 99 ? "99+" : String(count)) : null, label };
}

/** Every word the attention panel says. */
export const ATTENTION_WORDS = {
  needsYou: "Needs you",
  notifications: "Notifications",
  markAllRead: "Mark all read",
  clearAll: "Clear all",
  /** What the notification feed says while it holds nothing. */
  feedEmpty: "Nothing yet",
} as const;
