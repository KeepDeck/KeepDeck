import { needsPerson } from "../domain/status";
import type { UnconnectedLaunch } from "../domain/agents";
import type { ActivityBadge, ActivityTone } from "./activityBadge";
import { unconnectedLaunchView } from "./unconnectedLaunchView";
import { contextLevel, formatAge, type UsageLevel } from "../domain/usage";
import { teamBadgeTitle } from "@keepdeck/ui-kit/teamWords";

/** What a pane's header shows, settled — the header maps it and decides
 * nothing. */
export interface PaneHeaderView {
  /** The status dot, or null while nothing is known about the agent. A pane
   * whose agent runs without KeepDeck's setup wears `unconnected` — it can
   * report nothing, so the dot says why instead. */
  status: { tone: ActivityTone | "unconnected"; label: string; tooltip: string } | null;
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
  /** Why the pane's agent runs without KeepDeck's setup, when it does. */
  unconnected: UnconnectedLaunch | undefined;
  /** The minute clock the tooltip ages against. */
  now: number;
  ctxPct: number | undefined;
  paneLive: boolean;
  team: { name: string; role: string } | null | undefined;
  showTeamName: boolean | undefined;
}


/** The dot: what the agent said, else why it can say nothing. An unconnected
 * agent has no lane to report on, so the two never compete in practice —
 * the agent's word still goes first, being the fresher fact. */
function headerStatus(
  activity: ActivityBadge | null,
  unconnected: UnconnectedLaunch | undefined,
  now: number,
): PaneHeaderView["status"] {
  if (activity) {
    return {
      tone: activity.tone,
      label: activity.label,
      tooltip: `${activity.label}${activity.detail ? ` — ${activity.detail}` : ""} · ${formatAge(activity.at, now)}`,
    };
  }
  if (!unconnected) return null;
  const view = unconnectedLaunchView(unconnected);
  return { tone: "unconnected", label: view.label, tooltip: `${view.label} — ${view.reason}` };
}

export function paneHeaderView(input: PaneHeaderInput): PaneHeaderView {
  const { activity, unconnected, now, ctxPct, paneLive, team, showTeamName } = input;
  return {
    status: headerStatus(activity, unconnected, now),
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
  /** The dim mark between the title and the role. */
  separator: "·",
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
