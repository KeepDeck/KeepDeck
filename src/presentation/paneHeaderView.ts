import type { ActivityBadge, ActivityTone } from "../domain/status";
import { contextLevel, formatAge, type UsageLevel } from "../domain/usage";
import { teamBadgeTitle } from "../ui/badges";

/** What a pane's header shows, settled — the header maps it and decides
 * nothing. */
export interface PaneHeaderView {
  /** The status dot, or null before the agent reports a turn. */
  status: { tone: ActivityTone; label: string; tooltip: string } | null;
  /** The state in words, beside the controls — only while the agent needs
   * a person (waiting) or has stopped short (failed). Working and done are
   * the dot's to say; words for them would be the header talking all day. */
  stateWord: string | null;
  /** Which teammate this is: the role, the address teammates write to —
   * and the team too where the deck runs more than one. */
  role: { text: string; title: string } | null;
  /** How full the agent's context is, while it has a live process. */
  ctx: { label: string; title: string; level: UsageLevel } | null;
}

export interface PaneHeaderInput {
  activity: ActivityBadge | null;
  /** The minute clock the tooltip ages against. */
  now: number;
  ctxPct: number | undefined;
  paneLive: boolean;
  team: { name: string; role: string } | null | undefined;
  showTeamName: boolean | undefined;
}

const SPOKEN: ReadonlySet<ActivityTone> = new Set(["waiting", "failed"]);

export function paneHeaderView(input: PaneHeaderInput): PaneHeaderView {
  const { activity, now, ctxPct, paneLive, team, showTeamName } = input;
  return {
    status: activity && {
      tone: activity.tone,
      label: activity.label,
      tooltip: `${activity.label}${activity.detail ? ` — ${activity.detail}` : ""} · ${formatAge(activity.at, now)}`,
    },
    stateWord: activity && SPOKEN.has(activity.tone) ? activity.label : null,
    role: team
      ? {
          text: showTeamName ? `${team.role} · ${team.name}` : team.role,
          title: teamBadgeTitle(team.name, team.role),
        }
      : null,
    ctx:
      ctxPct !== undefined && paneLive
        ? {
            label: `${Math.ceil(ctxPct)}%`,
            title: `Context ${Math.ceil(ctxPct)}% used`,
            level: contextLevel(ctxPct),
          }
        : null,
  };
}
