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
 * the team cards' agent counts and by the panes being on screen — it is
 * gone rather than relocated. The build number went to the strip's own foot,
 * which is chrome that already exists. Quota stayed, because a subscription
 * running out is the one fact here that changes what you do next.
 *
 * The left half says where you are and what you have; the right half, what to
 * do and where to go. Two halves of one strip rather than two strips.
 *
 * WHAT IT DOES NOT DECIDE, on purpose: whether a control is worth showing,
 * and what a press ultimately does. Both belong to the composition root —
 * `dock`, `notifications`, the team and `updateAction` arrive null
 * when their control has no business existing, and every action is a
 * callback. So
 * the bar itself reaches for no manager, no store and no router; it draws
 * what it is handed. That is the whole seam, and it is what lets a change to
 * the ARRANGEMENT stay inside this file.
 *
 * The two LIVE READINGS are the exception, and a deliberate one: the usage
 * chips and the notification bell take their own data, per the convention the
 * settings sections state outright ("sections talk to the settings store
 * themselves"). The line the app draws is by KIND of data, not by taste — the
 * app's model (deck, workspaces, agents, plugins) arrives through the
 * controller as ports, and local stores are consumed where they are used. A
 * bar that had to be handed four usage hooks would put them back in App.tsx,
 * which is where they came from.
 */
import type { AgentInfo } from "../../domain/agents";
import type { Notification } from "../../domain/notifications";
import type { NotificationCenter } from "../../app/notificationCenter";
import type { UpdateAction, UpdateActionView } from "../../app/updateAction";
import type { Contribution } from "../../plugins/registries/contributions";
import type { TopBarActionContribution } from "@keepdeck/plugin-api";
import { fitBarGroup, PLUGIN_ACTION_SLOTS } from "../../domain/deck/topBar";
import { Button } from "../../ui/Button";
import { BranchBadge } from "../../ui/badges";
import { MenuButton } from "../../ui/MenuButton";
import { BAR_TIP_DELAY_MS, TipButton } from "../../ui/TipButton";
import { Tooltip } from "../../ui/Tooltip";
import {
  ArtifactsIcon,
  DockIcon,
  GearIcon,
  McpIcon,
  SkillsIcon,
  StatsIcon,
  TasksIcon,
} from "../AppIcons";
import { NotificationBell } from "../notifications/NotificationBell";
import { WorkspaceCrumb, type WorkspaceCrumbProps } from "./WorkspaceCrumb";
import { BAR_WORDS, type BarLevel } from "../../presentation/barView";
import type { NeedsYouRow } from "../../presentation/needsYouView";
import { UsageChips } from "../usage/UsageChips";

export interface DeckBarProps {
  /** The workspace on screen and its menu, or null with none. */
  workspace: WorkspaceCrumbProps | null;

  agents: AgentInfo[];
  /** Agent ids with a pane in the deck — the roster the usage chips stand for. */
  usageLiveAgents: ReadonlySet<string>;

  /** What the update control says and does, or null when there is no update
   *  to speak of. Transient by nature, so it costs no permanent room. */
  updateAction: UpdateActionView | null;
  onUpdateAction(action: UpdateAction): void;

  /** The level the stage is on, and the one affirmative act the bar offers
   *  there: at the teams level a new team; inside a team, another member. */
  level: BarLevel;

  /** The dock toggle, or null when no plugin contributes a dock tab. */
  dock: { open: boolean; onToggle(): void } | null;

  pluginActions: readonly Contribution<TopBarActionContribution>[];

  /** False while a transaction or another dialog owns the modal layer. */
  canOpenDialog: boolean;
  onOpenStats(): void;
  onOpenSkills(): void;
  onOpenMcp(): void;
  /** The artifacts registry, or null while Fleet artifacts are off — a door
   * to a feature that is not running is a door to a refusal. */
  onOpenArtifacts: (() => void) | null;
  /** The task board, or null while Tasks are off — the same rule. */
  onOpenTasks: (() => void) | null;
  onOpenSettings(): void;

  /** The agents blocked on the person, across every workspace, and how to
   *  bring one forward. Always handed in: who needs you is live state, not
   *  a notification preference. */
  needsYou: {
    rows: readonly NeedsYouRow[];
    onOpen(row: NeedsYouRow): void;
  };

  /** The in-app notification list, or null when notifications are off or
   *  delegated to the system. */
  notifications: {
    center: NotificationCenter;
    onOpen(notification: Notification): void;
  } | null;
}

export function DeckBar({
  workspace,
  agents,
  usageLiveAgents,
  updateAction,
  onUpdateAction,
  level,
  dock,
  pluginActions,
  canOpenDialog,
  onOpenStats,
  onOpenSkills,
  onOpenMcp,
  onOpenArtifacts,
  onOpenTasks,
  onOpenSettings,
  needsYou,
  notifications,
}: DeckBarProps) {
  // The plugin group has a ceiling; whatever passes it folds into a menu, so
  // the bar stops growing with the number of plugins installed.
  const { shown: pluginShown, overflow: pluginOverflow } = fitBarGroup(
    pluginActions,
    PLUGIN_ACTION_SLOTS,
  );
  return (
    <header className="deck__bar">
      <div className="deck__bar-left">
        {/* Where you are: the workspace (the strip's marks say only its
            initials) with its menu, and inside a team the way back to the
            cards, the team's name and the branch it works on. */}
        {workspace && (
          <WorkspaceCrumb {...workspace} />
        )}
        {level.kind === "team" && (
          <div className="bar__group deck__team-bar">
            <TipButton
              variant="ghost"
              size="sm"
              tip={BAR_WORDS.backTip}
              label={BAR_WORDS.back}
              onClick={level.onBack}
            >
              ←
            </TipButton>
            {/* The app's own tip, not a `title`: this WebView draws no
                native tooltip (see TipButton), and an ellipsized team name
                must be recoverable somewhere. */}
            <Tooltip tip={level.name} delayMs={BAR_TIP_DELAY_MS}>
              <span className="deck__team-name">{level.name}</span>
            </Tooltip>
            {level.branch !== null && (
              <BranchBadge
                className="deck__team-branch"
                size="sm"
                label={level.branch}
                title={level.branch}
              />
            )}
          </div>
        )}
      </div>

      {/* Quota sits in the MIDDLE, alone in its own zone.
          Pinned left it landed directly above the rail's column and read as
          the rail's own heading; pinned right it queued behind the verbs and
          became one more thing to sort. The centre belongs to nothing else,
          so a reading of the fleet can hold it without borrowing meaning from
          a neighbour. True centring needs a grid: with a flex row the middle
          only looks centred while the two sides happen to match. Nothing else
          joins it — a second occupant makes the centre a list, and a list has
          no centre. */}
      <div className="deck__bar-center">
        <UsageChips
          agents={agents}
          liveAgents={usageLiveAgents}
          onOpenStats={onOpenStats}
        />
      </div>
      <div className="deck__bar-right">
        {/* UPDATE — a verb, so it lives among the verbs rather than beside a
            reading of the fleet. It leads the right-hand run, one seam in
            front of Create: the two are the only things here that CHANGE
            something, and of the two an update is the rarer, which is why it
            stands first and Create keeps the position it always had relative
            to the panels. Its own group, so appearing and going again costs
            the create control no change of shape. */}
        {updateAction && (
          <div className="bar__group">
            <Tooltip tip={updateAction.title} delayMs={BAR_TIP_DELAY_MS}>
              <Button
                variant="secondary"
                size="sm"
                className="bar__update"
                onClick={() => onUpdateAction(updateAction.action)}
                disabled={updateAction.disabled}
                label={updateAction.label}
              >
                {updateAction.label}
              </Button>
            </Tooltip>
          </div>
        )}

        {/* CREATE — the bar's one affirmative act, and the only filled control
            on it. ONE door per level: at the teams level a team is the only
            thing to start; inside a team, a member is the only thing to add.
            No menu: the level already chose. */}
        {level.kind === "team" ? (
          <div className="bar__group">
            <TipButton
              variant="primary"
              size="sm"
              onClick={level.onAddMember}
              disabled={!level.canAddMember}
              tip={level.addMemberTitle}
              label={BAR_WORDS.addMemberLabel}
            >
              {BAR_WORDS.addMember}
            </TipButton>
          </div>
        ) : (
          level.onAddTeam && (
            <div className="bar__group">
              <TipButton
                variant="primary"
                size="sm"
                onClick={level.onAddTeam}
                tip={BAR_WORDS.addTeamTip}
                label={BAR_WORDS.addTeamLabel}
              >
                {BAR_WORDS.addTeam}
              </TipButton>
            </div>
          )
        )}

        {/* PANELS — what to show and hide. Nothing here changes the deck; it
            changes what you can see of it, which is its own kind of act. */}
        {(dock || pluginShown.length > 0 || pluginOverflow.length > 0) && (
          <div className="bar__group">
            {dock && (
              <TipButton
                variant="ghost"
                size="sm"
                tip={dock.open ? "Hide the dock" : "Show the dock"}
                label="Toggle dock panel"
                onClick={dock.onToggle}
              >
                <DockIcon />
              </TipButton>
            )}
            {pluginShown.map((contribution) => (
              <TipButton
                variant="ghost"
                size="sm"
                key={`${contribution.pluginId}:${contribution.entry.id}`}
                tip={contribution.entry.title}
                onClick={() => contribution.entry.run()}
              >
                {contribution.entry.Icon ? (
                  <contribution.entry.Icon />
                ) : (
                  contribution.entry.title.slice(0, 1)
                )}
              </TipButton>
            ))}
            {pluginOverflow.length > 0 && (
              <Tooltip tip="More plugin actions" delayMs={BAR_TIP_DELAY_MS}>
                <MenuButton
                  variant="ghost"
                  size="sm"
                  ariaLabel="More plugin actions"
                  actions={pluginOverflow.map((contribution) => ({
                    id: `${contribution.pluginId}:${contribution.entry.id}`,
                    label: contribution.entry.title,
                    onSelect: () => contribution.entry.run(),
                  }))}
                >
                  ⋯
                </MenuButton>
              </Tooltip>
            )}
          </div>
        )}

        {/* GO — places to be, not things to do. All one weight, because
            ranking a settings dialog above a skills library is a claim
            nobody can make on the user's behalf. */}
        <div className="bar__group">
          <TipButton
            variant="ghost"
            size="sm"
            tip="Open statistics"
            onClick={onOpenStats}
            disabled={!canOpenDialog}
          >
            <StatsIcon />
          </TipButton>
          {/* Who needs you — "N need you" while anyone does, else the
              notification bell; it draws nothing when neither has anything
              to say. */}
          <NotificationBell needsYou={needsYou} notifications={notifications} />
          <TipButton
            variant="ghost"
            size="sm"
            tip="Open skills"
            onClick={onOpenSkills}
            disabled={!canOpenDialog}
          >
            <SkillsIcon />
          </TipButton>
          <TipButton
            variant="ghost"
            size="sm"
            tip="Open MCP servers"
            onClick={onOpenMcp}
            disabled={!canOpenDialog}
          >
            <McpIcon />
          </TipButton>
          {onOpenArtifacts && (
            <TipButton
              variant="ghost"
              size="sm"
              tip="Open artifacts"
              onClick={onOpenArtifacts}
              disabled={!canOpenDialog}
            >
              <ArtifactsIcon />
            </TipButton>
          )}
          {onOpenTasks && (
            <TipButton
              variant="ghost"
              size="sm"
              tip="Open tasks"
              onClick={onOpenTasks}
              disabled={!canOpenDialog}
            >
              <TasksIcon />
            </TipButton>
          )}
          <TipButton
            variant="ghost"
            size="sm"
            tip="Open settings"
            onClick={onOpenSettings}
            disabled={!canOpenDialog}
          >
            <GearIcon />
          </TipButton>
        </div>
      </div>
    </header>
  );
}
