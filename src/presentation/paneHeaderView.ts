import { needsPerson, type ActivityBadge, type ActivityTone } from "../domain/status";
import { contextLevel, formatAge, type UsageLevel } from "../domain/usage";
import { teamBadgeTitle } from "@keepdeck/ui-kit/teamWords";

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


export function paneHeaderView(input: PaneHeaderInput): PaneHeaderView {
  const { activity, now, ctxPct, paneLive, team, showTeamName } = input;
  return {
    status: activity && {
      tone: activity.tone,
      label: activity.label,
      tooltip: `${activity.label}${activity.detail ? ` — ${activity.detail}` : ""} · ${formatAge(activity.at, now)}`,
    },
    stateWord: activity && needsPerson(activity.tone) ? activity.label : null,
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

/** The header's words that are not about the agent's state. */
export const PANE_HEADER_WORDS = {
  renameField: "Rename agent",
  renameHint: "Double-click to rename",
} as const;

/** The header's window controls, decided: minimize only while the pane is
 * not maximized and can be minimized; maximize/restore only when the pane
 * is not alone on the grid; close always. */
export interface PaneControlsView {
  minimize: { tip: string; label: string } | null;
  /** Maximize, or restore when already maximized. */
  spotlight: { tip: string; label: string; restore: boolean } | null;
  close: { label: string };
}

export function paneControlsView(input: {
  title: string;
  focused: boolean;
  solo: boolean;
  canMinimize: boolean;
}): PaneControlsView {
  const { title, focused, solo, canMinimize } = input;
  return {
    minimize: canMinimize && !focused ? { tip: "Minimize agent", label: `Minimize ${title}` } : null,
    spotlight: solo
      ? null
      : focused
        ? { tip: "Restore", label: `Restore ${title}`, restore: true }
        : { tip: "Maximize", label: `Maximize ${title}`, restore: false },
    close: { label: `Close ${title}` },
  };
}
