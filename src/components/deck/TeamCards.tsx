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
 * The live activity arrives from the controller's one subscription (the
 * snapshot is stable between edges), so the projection recomputes only
 * when an edge lands, the deck changes shape, or a head moves. The task
 * board is a local store read where it is used, like the usage chips'.
 */
import { useMemo } from "react";
import { useAppRuntime } from "../../app/runtimeContext";
import { readyBoard } from "../../app/tasks/tasksService";
import { useTasksBoardState } from "../tasks/useBoardState";
import type { GitPosition, Workspace } from "../../domain/deck";
import type { PaneActivity } from "../../domain/status";
import {
  TEAM_CARD_WORDS,
  teamCardsView,
  type TeamCardAction,
  type TeamCardView,
} from "../../presentation/teamCardView";
import { BranchBadge } from "../../ui/badges";
import { RenameInput } from "../../ui/RenameInput";
import { MenuButton, type MenuAction } from "../../ui/MenuButton";
import { useInlineRename, type InlineRename } from "../../ui/useInlineRename";

export interface TeamCardsProps {
  workspace: Workspace;
  /** Every pane's live activity — the controller's one subscription, the
   * same the strip reads (`usePaneActivities`). */
  activities: ReadonlyMap<string, PaneActivity>;
  /** Live git heads by directory — a card's branch follows the head. */
  gitHeads: ReadonlyMap<string, GitPosition>;
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
}

export function TeamCards({
  workspace,
  activities,
  gitHeads,
  keyboardFocusEnabled,
  onEnter,
  onAddMember,
  onRename,
  onDisband,
  onRetry,
}: TeamCardsProps) {
  const { tasks } = useAppRuntime();
  const boardState = useTasksBoardState(tasks, workspace.id);
  const board = readyBoard(boardState);
  const cards = useMemo(
    () => teamCardsView(workspace, activities, gitHeads, board),
    [workspace, gitHeads, activities, board],
  );
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
}: {
  card: TeamCardView;
  rename: InlineRename;
  onEnter(teamId: string): void;
  onAddMember(teamId: string): void;
  onDisband(teamId: string): void;
  onRetry(teamId: string): void;
}) {
  // The described action → the callback that owns it. Exhaustive: an
  // action the projection learns to describe cannot be one the card
  // forgets to perform.
  const perform = (action: TeamCardAction) => {
    switch (action) {
      case "add-member":
        onAddMember(card.id);
        break;
      case "rename":
        rename.start(card.id, card.name);
        break;
      case "disband":
        onDisband(card.id);
        break;
      case "retry":
        onRetry(card.id);
        break;
      default: {
        const unhandled: never = action;
        throw new Error(`unhandled team card action: ${String(unhandled)}`);
      }
    }
  };
  const actions: MenuAction[] = card.actions.map((action) => ({
    id: action,
    label: TEAM_CARD_WORDS.action[action],
    disabled: card.refusals[action] !== undefined,
    refusal: card.refusals[action],
    onSelect: () => perform(action),
  }));
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
            label={TEAM_CARD_WORDS.renameField}
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
            ariaLabel={TEAM_CARD_WORDS.menu(card.name)}
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
