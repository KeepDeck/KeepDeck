/**
 * What the bar's attention control says — "N need you" and the list behind
 * it — decided apart from the markup, the [`stripView`] precedent.
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

/** What the bar's trigger shows: the count while anyone needs you, else the
 * plain bell where the in-app list is on, else nothing at all. */
export type AttentionTrigger =
  | { kind: "need"; tone: NeedsYouTone; text: string; label: string }
  | { kind: "bell"; badge: string | null; label: string }
  | null;

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
  if (rows.length > 0) {
    const n = rows.length;
    const text = `${n} need${n === 1 ? "s" : ""} you`;
    return {
      kind: "need",
      // The rows come louder first, so the first row's tone is the loudest.
      tone: rows[0].tone,
      text,
      label: `${n === 1 ? "1 agent needs" : `${n} agents need`} you`,
    };
  }
  if (!bell) return null;
  return {
    kind: "bell",
    badge: bell.unread > 0 ? (bell.unread > 99 ? "99+" : String(bell.unread)) : null,
    label: bell.unread > 0 ? `Notifications (${bell.unread} unread)` : "Notifications",
  };
}

/** What the notification feed says while it holds nothing. */
export const FEED_EMPTY = "Nothing yet";

/** Where ⌘J goes: the row after the agent the person is on, wrapping to the
 * first — so repeated presses walk the list in its order (failed first) —
 * or the first row when the person is on none of them. Null when nobody
 * needs the person. */
export function nextNeedsYou(
  rows: readonly NeedsYouRow[],
  current: { wsId: string; paneId: string } | null,
): NeedsYouRow | null {
  if (rows.length === 0) return null;
  const at = current
    ? rows.findIndex((row) => row.wsId === current.wsId && row.paneId === current.paneId)
    : -1;
  return rows[(at + 1) % rows.length];
}
