/**
 * The teams level of the stage: one card per team, gridded.
 *
 * What a card SAYS is `teamCardView`'s (presentation/teamCardView.ts); this
 * file draws it and turns each described action into the callback it owns.
 * The card is seven things — dot, name, ⋯ menu, branch, how many agents,
 * the directory, the tasks line — and nothing else: no agent statuses, no
 * terminal, no error text, no buttons. Retry lives in the menu like
 * everything else a card can do. One anatomy for every state; a team of
 * one is drawn like any other.
 *
 * The projection is recomputed on every render: besides the deck, the
 * activity and the heads it reads whom each team's Suspend and Resume would
 * take — the orchestrator's live answer (`actsOf`), which moves with the
 * sweep's folder verdict and the agent catalog, neither of them a prop
 * here. It is a handful of teams. The task board is a local store read
 * where it is used, like the usage chips'.
 */
import { useRuntimePart } from "../../app/runtimeContext";
import { useReadyTasksBoard } from "../../app/tasks/useBoardState";
import type { GitPosition, TeamActs, Workspace } from "../../domain/deck";
import type { PaneActivity } from "../../domain/status";
import { TEAM_CARD_WORDS, teamCardsView, type TeamCardView } from "../../presentation/teamCardView";
import { TEAM_MENU_WORDS } from "../../presentation/teamMenuView";
import { BranchBadge } from "../../ui/badges";
import { RenameInput } from "../../ui/RenameInput";
import { MenuButton } from "../../ui/MenuButton";
import { useInlineRename, type InlineRename } from "../../ui/useInlineRename";
import { teamMenuActions } from "./teamMenuActions";

export interface TeamCardsProps {
  workspace: Workspace;
  /** Every pane's live activity — the controller's one subscription, the
   * same the strip reads (`usePaneActivities`). */
  activities: ReadonlyMap<string, PaneActivity>;
  /** Live git heads by directory — a card's branch follows the head. */
  gitHeads: ReadonlyMap<string, GitPosition>;
  /** Whom each team's Suspend and Resume would take right now. */
  actsOf(teamId: string): TeamActs | null;
  /** Whether this layer may hold the keyboard; a rename in flight is
   * dropped the moment it may not (a dialog over it, another workspace). */
  keyboardFocusEnabled: boolean;
  /** Drill into the team. */
  onEnter(teamId: string): void;
  onAddMember(teamId: string): void;
  onRename(teamId: string, name: string): void;
  onDisband(teamId: string): void;
  /** Re-issue the failed worktree create behind a card. */
  onRetry(teamId: string): void;
  /** Ask the team's stopped agents back — no question asked. */
  onResume(teamId: string): void;
  /** Ask to stop the team's running agents — its confirm decides. */
  onSuspend(teamId: string): void;
}

export function TeamCards({
  workspace,
  activities,
  gitHeads,
  actsOf,
  keyboardFocusEnabled,
  onEnter,
  onAddMember,
  onRename,
  onDisband,
  onRetry,
  onResume,
  onSuspend,
}: TeamCardsProps) {
  const tasks = useRuntimePart("tasks");
  const board = useReadyTasksBoard(tasks, workspace.id);
  const cards = teamCardsView(workspace, activities, gitHeads, board, actsOf);
  // One rename behaviour for every surface that has one ([F11]); an empty
  // commit is "back to the auto name", which renameTeam implements.
  const rename = useInlineRename((teamId, name) => onRename(teamId, name), keyboardFocusEnabled);
  return (
    <div className="deck__teams" role="list" aria-label="Teams">
      {cards.map((card) => (
        <TeamCard
          key={card.id}
          card={card}
          rename={rename}
          onEnter={onEnter}
          onAddMember={onAddMember}
          onDisband={onDisband}
          onRetry={onRetry}
          onResume={onResume}
          onSuspend={onSuspend}
        />
      ))}
    </div>
  );
}

function TeamCard({
  card,
  rename,
  onEnter,
  onAddMember,
  onDisband,
  onRetry,
  onResume,
  onSuspend,
}: {
  card: TeamCardView;
  rename: InlineRename;
  onEnter(teamId: string): void;
  onAddMember(teamId: string): void;
  onDisband(teamId: string): void;
  onRetry(teamId: string): void;
  onResume(teamId: string): void;
  onSuspend(teamId: string): void;
}) {
  const actions = teamMenuActions(card.menu, {
    addMember: () => onAddMember(card.id),
    rename: () => rename.start(card.id, card.name),
    resume: () => onResume(card.id),
    suspend: () => onSuspend(card.id),
    disband: () => onDisband(card.id),
    retry: () => onRetry(card.id),
  });
  const editing = rename.editing === card.id;
  return (
    <article
      className={card.className}
      data-team-id={card.id}
      role="listitem"
      aria-label={TEAM_CARD_WORDS.card(card.name)}
      // The whole card is the way in; the menu below stops its own clicks.
      onClick={() => onEnter(card.id)}
    >
      <div className="team-card__head">
        <span
          className={`team-card__dot team-dot team-dot--${card.dot}`}
          role="img"
          aria-label={TEAM_CARD_WORDS.dot[card.dot]}
          title={TEAM_CARD_WORDS.dot[card.dot]}
        />
        {editing ? (
          <RenameInput
            rename={rename}
            className="team-card__rename"
            label={TEAM_MENU_WORDS.renameField}
            contained
          />
        ) : (
          <button
            type="button"
            className="team-card__open"
            title={TEAM_CARD_WORDS.openHint}
            onClick={(event) => {
              event.stopPropagation();
              onEnter(card.id);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              rename.start(card.id, card.name);
            }}
          >
            <span className="team-card__name">{card.name}</span>
          </button>
        )}
        <span className="team-card__menu" onClick={(event) => event.stopPropagation()}>
          <MenuButton
            variant="ghost"
            size="sm"
            actions={actions}
            ariaLabel={TEAM_MENU_WORDS.ariaLabel(card.name)}
          >
            ⋯
          </MenuButton>
        </span>
      </div>
      <div className="team-card__meta">
        {card.branch !== null && (
          <BranchBadge
            className="team-card__branch"
            size="sm"
            label={card.branch}
            title={card.branch}
          />
        )}
        <span className="team-card__count">{TEAM_CARD_WORDS.agents(card.size)}</span>
      </div>
      <span className="team-card__dir" title={card.cwd}>
        {card.dir}
      </span>
      {card.tasksLine !== null && <div className="team-card__tasks">{card.tasksLine}</div>}
    </article>
  );
}
