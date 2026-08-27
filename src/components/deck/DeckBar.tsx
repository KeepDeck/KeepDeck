/**
 * The deck's top bar: what you can DO here, and where you can go.
 *
 * It lived inline in `App`, which is why it grew the way it did — a bar with
 * no file of its own has no place to state what belongs in it, and every
 * addition was one more node in a 150-line run.
 *
 * WHAT BELONGS: actions on the deck, and destinations away from it. Nothing
 * else. What is merely TRUE — quota, agent count, an update waiting — went to
 * the status strip along the bottom, because a strip answering "what do I do"
 * and "how much quota is left" in one breath makes a reader sort two kinds of
 * thing by eye before either can be read.
 *
 * WHAT IT DOES NOT DECIDE, on purpose: whether a control is worth showing,
 * and what a press ultimately does. Both belong to the composition root —
 * `dock`, `notifications` and `onAddTeam` arrive null when their control has
 * no business existing, and every action is a callback. So the bar reaches
 * for no manager, no store and no router; it draws what it is handed. That
 * is the whole seam, and it is what lets a change to the ARRANGEMENT stay
 * inside this file.
 */
import type { Notification } from "../../domain/notifications";
import type { NotificationCenter } from "../../app/notificationCenter";
import type { Contribution } from "../../plugins/registries/contributions";
import type { TopBarActionContribution } from "@keepdeck/plugin-api";
import { Button } from "../../ui/Button";
import { DockIcon, GearIcon, SidebarIcon, SkillsIcon, StatsIcon } from "../AppIcons";
import { NotificationBell } from "../notifications/NotificationBell";

export interface DeckBarProps {
  /** Whether the workspaces rail is hidden — the toggle's own state. */
  railCollapsed: boolean;
  onToggleRail(): void;
  /** The active workspace's name, or null when the rail is showing it (or
   *  there is no active workspace). The bar does not re-derive that: which
   *  surface names the workspace is a layout decision, not the bar's. */
  workspaceName: string | null;

  canAddAgent: boolean;
  /** The add control's tooltip, which is also where a refusal is explained. */
  addAgentTitle: string;
  onAddAgent(): void;

  /** Opens a NEW team, or null while the teams experiment is off or no
   *  workspace is active. */
  onAddTeam: (() => void) | null;

  /** The dock toggle, or null when no plugin contributes a dock tab. */
  dock: { open: boolean; onToggle(): void } | null;

  pluginActions: readonly Contribution<TopBarActionContribution>[];

  /** False while a transaction or another dialog owns the modal layer. */
  canOpenDialog: boolean;
  onOpenStats(): void;
  onOpenSkills(): void;
  onOpenSettings(): void;

  /** The notification bell, or null when notifications are off or delegated
   *  to the system. */
  notifications: {
    center: NotificationCenter;
    onOpen(notification: Notification): void;
  } | null;
}

export function DeckBar({
  railCollapsed,
  onToggleRail,
  workspaceName,
  canAddAgent,
  addAgentTitle,
  onAddAgent,
  onAddTeam,
  dock,
  pluginActions,
  canOpenDialog,
  onOpenStats,
  onOpenSkills,
  onOpenSettings,
  notifications,
}: DeckBarProps) {
  return (
    <header className="deck__bar">
      <div className="deck__bar-left">
        <Button
          variant="ghost"
          size="sm"
          title={railCollapsed ? "Show workspaces" : "Hide workspaces"}
          label="Toggle workspaces panel"
          onClick={onToggleRail}
        >
          <SidebarIcon />
        </Button>
        <span className="deck__brand">KeepDeck</span>
        {workspaceName !== null && (
          <span className="deck__active-ws" title={workspaceName}>
            {workspaceName}
          </span>
        )}
      </div>
      <div className="deck__bar-right">
        <button
          type="button"
          className="bar__action"
          onClick={onAddAgent}
          disabled={!canAddAgent}
          title={addAgentTitle}
        >
          + Agent
        </button>
        {onAddTeam && (
          // Beside "+ Agent" because it is the same kind of act — setting up
          // who is working here — and because a team is a property of this
          // workspace, which is what this bar is about.
          //
          // ALWAYS a new one, the way "+ Agent" beside it always adds an
          // agent. An existing team is opened from the badge on any pane that
          // is on it, which is where somebody looking at a team is already
          // looking — and it is the gesture that scales, since a workspace may
          // run several.
          <button
            type="button"
            className="bar__action"
            onClick={onAddTeam}
            title="Group agents into a team so they can write to each other by role"
          >
            + Team
          </button>
        )}
        {dock && (
          <Button
            variant="ghost"
            size="sm"
            title={dock.open ? "Hide the dock" : "Show the dock"}
            label="Toggle dock panel"
            onClick={dock.onToggle}
          >
            <DockIcon />
          </Button>
        )}
        {pluginActions.map((contribution) => (
          <Button
            variant="ghost"
            size="sm"
            key={`${contribution.pluginId}:${contribution.entry.id}`}
            title={contribution.entry.title}
            onClick={() => contribution.entry.run()}
          >
            {contribution.entry.Icon ? (
              <contribution.entry.Icon />
            ) : (
              contribution.entry.title.slice(0, 1)
            )}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          title="Statistics"
          label="Open statistics"
          onClick={onOpenStats}
          disabled={!canOpenDialog}
        >
          <StatsIcon />
        </Button>
        {notifications && (
          <NotificationBell
            center={notifications.center}
            onOpen={notifications.onOpen}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          title="Skills"
          label="Open skills"
          onClick={onOpenSkills}
          disabled={!canOpenDialog}
        >
          <SkillsIcon />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          title="Settings"
          label="Open settings"
          onClick={onOpenSettings}
          disabled={!canOpenDialog}
        >
          <GearIcon />
        </Button>
      </div>
    </header>
  );
}
