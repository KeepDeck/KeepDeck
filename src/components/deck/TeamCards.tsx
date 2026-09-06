/**
 * The teams level of the stage: one card per team, gridded.
 *
 * What a card SAYS is `teamCardView`'s (presentation/teamCardView.ts); this
 * file draws it and turns each described action into the callback it owns.
 * The card is six things — dot, name, ⋯ menu, branch, how many agents, the
 * directory — and nothing else: no agent statuses, no terminal, no error
 * text, no buttons. Retry lives in the menu like everything else a card can
 * do. One anatomy for every state; a team of one is drawn like any other.
 *
 * One subscription for the whole layer (the `useWorkspaceFrames` shape): the
 * status snapshot is stable between edges, so the projection recomputes
 * only when an edge lands, the deck changes shape, or a head moves.
 */
import { useMemo, useSyncExternalStore } from "react";
import { useAppRuntime } from "../../app/runtimeContext";
import {
  baseName,
  membersOf,
  teamHeldPath,
  teamsOf,
  type GitPosition,
  type Workspace,
} from "../../domain/deck";
import {
  teamCardView,
  type TeamCardAction,
  type TeamCardDot,
  type TeamCardView,
} from "../../presentation/teamCardView";
import { BranchBadge } from "../../ui/badges";
import { noAutoCorrect } from "../../ui/inputProps";
import { MenuButton, type MenuAction } from "../../ui/MenuButton";
import { useInlineRename, type InlineRename } from "../../ui/useInlineRename";

export interface TeamCardsProps {
  workspace: Workspace;
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

/** The menu's words, one per described action. */
const ACTION_LABEL: Record<TeamCardAction, string> = {
  open: "Open",
  "add-member": "+ Member",
  rename: "Rename",
  disband: "Disband",
  retry: "Retry the worktree",
};

/** The dot's words — the tooltip, and what a screen reader says. */
const DOT_LABEL: Record<TeamCardDot, string> = {
  failed: "Needs attention",
  waiting: "Waiting for you",
  creating: "Creating the worktree",
  working: "Working",
  done: "Done",
  none: "Idle",
};

const agentsOn = (size: number) =>
  size === 0 ? "No agents" : `${size} agent${size === 1 ? "" : "s"}`;

export function TeamCards({
  workspace,
  gitHeads,
  keyboardFocusEnabled,
  onEnter,
  onAddMember,
  onRename,
  onDisband,
  onRetry,
}: TeamCardsProps) {
  const { statusTracker } = useAppRuntime();
  const snapshot = useSyncExternalStore(statusTracker.subscribe, statusTracker.getSnapshot);
  const cards = useMemo(
    () =>
      teamsOf(workspace).map((team) =>
        teamCardView(
          workspace,
          team,
          membersOf(workspace, team.id).map((pane) => snapshot.panes.get(pane.id)),
          gitHeads.get(teamHeldPath(team) ?? workspace.cwd),
        ),
      ),
    [workspace, gitHeads, snapshot],
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
      case "open":
        onEnter(card.id);
        break;
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
    label: ACTION_LABEL[action],
    onSelect: () => perform(action),
  }));
  const editing = rename.editing === card.id;
  return (
    <article
      className={`team-card team-card--${card.dot}${card.pending ? " team-card--pending" : ""}`}
      data-team-id={card.id}
      role="listitem"
      aria-label={`Team ${card.name}`}
      // The whole card is the way in; the menu below stops its own clicks.
      onClick={() => onEnter(card.id)}
    >
      <div className="team-card__head">
        <span
          className={`team-card__dot team-card__dot--${card.dot}`}
          role="img"
          aria-label={DOT_LABEL[card.dot]}
          title={DOT_LABEL[card.dot]}
        />
        {editing ? (
          <input
            {...noAutoCorrect}
            {...rename.inputProps}
            className="team-card__rename"
            autoFocus
            aria-label="Rename team"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
          <button
            type="button"
            className="team-card__open"
            title="Open the team — double-click to rename"
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
            ariaLabel={`Team ${card.name} actions`}
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
        <span className="team-card__count">{agentsOn(card.size)}</span>
      </div>
      <span className="team-card__dir" title={card.cwd}>
        {baseName(card.cwd)}
      </span>
    </article>
  );
}
