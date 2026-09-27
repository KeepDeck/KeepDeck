/**
 * What the bar's attention control says — "N need you" and the list behind
 * it — decided apart from the markup, the [`railView`] precedent.
 *
 * The list is the deck's answer to "who is blocked on me", across every
 * workspace: an agent waiting for a person, or one whose turn died. Failed
 * rows lead (a dead turn does nothing until someone looks), then waiting;
 * inside each, the longest-blocked first. Working and done agents are not
 * here — the tiles and the tray already say them, and a list of everything
 * is a list of nothing.
 */
import {
  paneDisplayTitle,
  teamOfPane,
  type Workspace,
} from "../domain/deck";
import { activityBadge, type PaneActivity } from "../domain/status";
import { formatAge } from "../domain/usage";

export type NeedsYouTone = "failed" | "waiting";

/** One agent that is blocked on the person. */
export interface NeedsYouRow {
  wsId: string;
  paneId: string;
  tone: NeedsYouTone;
  /** The agent's name, as its tile says it. */
  title: string;
  /** Where it is: the workspace, and the team and role when it is on one. */
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

const RANK: Record<NeedsYouTone, number> = { failed: 0, waiting: 1 };

function blockedSince(activity: PaneActivity): { tone: NeedsYouTone; at: number } | null {
  switch (activity.state) {
    case "failed":
      return { tone: "failed", at: activity.at };
    case "waiting":
      return { tone: "waiting", at: activity.since };
    default:
      return null;
  }
}

export function needsYouRows(
  workspaces: readonly Workspace[],
  activities: ReadonlyMap<string, PaneActivity>,
  agents: readonly { id: string; label: string }[],
): NeedsYouRow[] {
  const found: NeedsYouRow[] = [];
  for (const ws of workspaces) {
    ws.panes.forEach((pane, index) => {
      // An idle pane (exited, suspended) has no process to answer; its own
      // card says so, and a stale "waiting" from before is not a request.
      if (pane.idle) return;
      const activity = activities.get(pane.id);
      const blocked = activity && blockedSince(activity);
      if (!activity || !blocked) return;
      const team = teamOfPane(ws, pane);
      found.push({
        wsId: ws.id,
        paneId: pane.id,
        tone: blocked.tone,
        title: paneDisplayTitle(pane, index, agents),
        where: [ws.name, team?.name, pane.team?.role].filter(Boolean).join(" · "),
        label: activityBadge(activity).label,
        since: blocked.at,
      });
    });
  }
  return found.sort((a, b) => RANK[a.tone] - RANK[b.tone] || a.since - b.since);
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
      tone: rows.some((r) => r.tone === "failed") ? "failed" : "waiting",
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
