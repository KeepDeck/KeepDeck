/**
 * The deck's top bar: the one strip of chrome the window carries.
 *
 * It lived inline in `App`, which is why it grew the way it did — a bar with
 * no file of its own has no place to state what belongs in it, and every
 * addition was one more node in a 150-line run.
 *
 * ONE strip, deliberately. State briefly lived in a second one along the
 * bottom, and the arithmetic of that was worse than the problem it solved:
 * the window went from one occupied edge to two, and the bottom edge had been
 * free except when the minimized tray needed it. Moving a thing is a saving
 * only if the place it lands was already paid for.
 *
 * So the reckoning ran the other way. The pane count was already answered by
 * the rail's per-workspace numbers and by the panes being on screen — it is
 * gone rather than relocated. The build number went to the rail's own footer,
 * which is chrome that already exists. Quota stayed, because a subscription
 * running out is the one fact here that changes what you do next.
 *
 * The left half says where you are and what you have; the right half, what to
 * do and where to go. Two halves of one strip rather than two strips.
 *
 * WHAT IT DOES NOT DECIDE, on purpose: whether a control is worth showing,
 * and what a press ultimately does. Both belong to the composition root —
 * `dock`, `notifications`, `onAddTeam` and `updateAction` arrive null when
 * their control has no business existing, and every action is a callback. So
 * the bar reaches for no manager, no store and no router; it draws what it is
 * handed. That is the whole seam, and it is what lets a change to the
 * ARRANGEMENT stay inside this file.
 */
import type { AgentInfo } from "../../domain/agents";
import type { Notification } from "../../domain/notifications";
import type { NotificationCenter } from "../../app/notificationCenter";
import type { UpdateAction, UpdateActionView } from "../../app/updateAction";
import type { Contribution } from "../../plugins/registries/contributions";
import type { TopBarActionContribution } from "@keepdeck/plugin-api";
import { fitBarGroup } from "../../domain/deck/topBar";
import { Button } from "../../ui/Button";
import { MenuButton, type MenuAction } from "../../ui/MenuButton";
import { DockIcon, GearIcon, SidebarIcon, SkillsIcon, StatsIcon } from "../AppIcons";
import { NotificationBell } from "../notifications/NotificationBell";
import { UsageChips } from "../usage/UsageChips";

export interface DeckBarProps {
  /** Whether the workspaces rail is hidden — the toggle's own state. */
  railCollapsed: boolean;
  onToggleRail(): void;
  /** The active workspace's name, or null when there is none. Named here
   *  whether or not the rail is open: the rail is a list you scan, and this
   *  is the one line that answers "where am I" without scanning. */
  workspaceName: string | null;

  agents: AgentInfo[];
  /** Agent ids with a pane in the deck — the roster the usage chips stand for. */
  usageLiveAgents: ReadonlySet<string>;

  /** What the update control says and does, or null when there is no update
   *  to speak of. Transient by nature, so it costs no permanent room. */
  updateAction: UpdateActionView | null;
  onUpdateAction(action: UpdateAction): void;

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
  agents,
  usageLiveAgents,
  updateAction,
  onUpdateAction,
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
        <span className="deck__brand">KeepDeck</span>
        {workspaceName !== null && (
          <span className="deck__active-ws" title={workspaceName}>
            {workspaceName}
          </span>
        )}
        {/* The left half answers "where am I and what have I got" — the
            project, and the room left to work in it. Keeping facts apart from
            the verbs on the right is the whole arrangement: two halves of one
            strip rather than two strips. */}
        <UsageChips
          agents={agents}
          liveAgents={usageLiveAgents}
          onOpenStats={onOpenStats}
        />
        {updateAction && (
          <Button
            variant="secondary"
            size="sm"
            className="bar__update"
            onClick={() => onUpdateAction(updateAction.action)}
            disabled={updateAction.disabled}
            title={updateAction.title}
          >
            {updateAction.label}
          </Button>
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
