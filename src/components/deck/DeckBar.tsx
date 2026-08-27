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
import { fitBarGroup } from "../../domain/deck/topBar";
import { Button } from "../../ui/Button";
import { MenuButton, type MenuAction } from "../../ui/MenuButton";
import { DockIcon, GearIcon, SidebarIcon, SkillsIcon, StatsIcon } from "../AppIcons";
import { NotificationBell } from "../notifications/NotificationBell";

export interface DeckBarProps {
  /** Whether the workspaces rail is hidden — the toggle's own state. */
  railCollapsed: boolean;
  onToggleRail(): void;
  /** The active workspace's name, or null when there is none. Named here
   *  whether or not the rail is open: the rail is a list you scan, and this
   *  is the one line that answers "where am I" without scanning. */
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
  // The ways to create, in the order they are offered. Adding an agent is
  // always one of them; starting a team joins it when the deck says so.
  const createActions: MenuAction[] = [
    {
      id: "agent",
      label: "Agent",
      onSelect: onAddAgent,
      disabled: !canAddAgent,
      title: addAgentTitle,
    },
  ];
  if (onAddTeam) {
    createActions.push({
      id: "team",
      label: "Team",
      onSelect: onAddTeam,
      title:
        "Group agents into a team so they can write to each other by role",
    });
  }
  // The plugin group has a ceiling; whatever passes it folds into a menu, so
  // the bar stops growing with the number of plugins installed.
  const { shown: pluginShown, overflow: pluginOverflow } =
    fitBarGroup(pluginActions);
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
        {/* Where you are, not what you are running. That the window is
            KeepDeck is the one thing a reader never forgets; which project
            it is pointed at is the thing they do. */}
        {workspaceName !== null && (
          <span className="deck__active-ws" title={workspaceName}>
            {workspaceName}
          </span>
        )}
      </div>
      <div className="deck__bar-right">
        {/* CREATE — the bar's one affirmative act, and the only filled control
            on it. Adding an agent and starting a team are the same kind of
            thing (deciding who works here), so they are one control with two
            ways, and a third way later costs a menu line rather than another
            button in the run. A menu of ONE would only put a click in front
            of the app's commonest action, so a lone way collapses back to a
            plain button. */}
        <div className="bar__group">
          {createActions.length === 1 ? (
            <Button
              variant="primary"
              size="sm"
              onClick={createActions[0].onSelect}
              disabled={createActions[0].disabled}
              title={createActions[0].title}
            >
              + {createActions[0].label}
            </Button>
          ) : (
            <MenuButton
              variant="primary"
              size="sm"
              actions={createActions}
              ariaLabel="Create"
              title="Add an agent or start a team"
            >
              + ▾
            </MenuButton>
          )}
        </div>

        {/* PANELS — what to show and hide. Nothing here changes the deck; it
            changes what you can see of it, which is its own kind of act. */}
        {(dock || pluginShown.length > 0 || pluginOverflow.length > 0) && (
          <div className="bar__group">
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
            {pluginShown.map((contribution) => (
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
            {pluginOverflow.length > 0 && (
              <MenuButton
                variant="ghost"
                size="sm"
                ariaLabel="More plugin actions"
                title="More plugin actions"
                actions={pluginOverflow.map((contribution) => ({
                  id: `${contribution.pluginId}:${contribution.entry.id}`,
                  label: contribution.entry.title,
                  onSelect: () => contribution.entry.run(),
                }))}
              >
                ⋯
              </MenuButton>
            )}
          </div>
        )}

        {/* GO — places to be, not things to do. All one weight, because
            ranking a settings dialog above a skills library is a claim
            nobody can make on the user's behalf. */}
        <div className="bar__group">
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
      </div>
    </header>
  );
}
