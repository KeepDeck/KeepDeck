import { formatTeamSpec } from "../../domain/mail";
import type { ActivityBadge } from "../../domain/status";
import { contextLevel, formatAge } from "../../domain/usage";
import { noAutoCorrect } from "../../ui/inputProps";
import { useInlineRename } from "../../ui/useInlineRename";
import {
  ChevronDownIcon,
  MaximizeIcon,
  MinimizeIcon,
  RestoreIcon,
  UsersIcon,
} from "../../ui/icons";
import { BranchBadge, TeamBadge, YoloBadge } from "../../ui/badges";
import { CloseButton } from "../../ui/CloseButton";
import { Chip } from "../../ui/Chip";
import type { GitBadge } from "../../ui/gitBadge";
import { AgentGlyph, type AgentGlyphIcon } from "../../ui/AgentGlyph";

export interface AgentPaneHeaderProps {
  /** Rename key — the editor survives a title change to the same pane. */
  paneId: string;
  title: string;
  agentIcon?: AgentGlyphIcon | null;
  agentLabel?: string;
  folded?: boolean;
  focused: boolean;
  solo: boolean;
  /** Badges — every value arrives settled; this header only renders. */
  activityView: ActivityBadge | null;
  /** The minute clock the activity tooltip ages against. */
  now: number;
  ctxPct: number | undefined;
  paneLive: boolean;
  yolo?: boolean;
  /** The pane's place on a team, when it is on one. Shown as the role,
   * because the role is the address teammates use. */
  team?: { name: string; role: string } | null;
  /** Whether the team surface is switched on at all — the agent-mail
   * experiment. Off, the header carries no team chip and no placeholder,
   * so nobody who is not using teams pays a pixel for them. */
  teams?: boolean;
  /** Commit a `role@team` spec, or blank to leave the team. Parsing and
   * refusing belong to whoever holds the deck; this only reports the text
   * the user typed. */
  onSetTeam?(spec: string): void;
  gitBadge?: GitBadge | null;
  /** False while a modal or covering dock owns keyboard interaction — an
   * inline rename must not be left in flight underneath one. */
  keyboardFocusEnabled: boolean;
  onSelect(): void;
  onRename(name: string): void;
  onMinimize?(): void;
  onToggleFocus(): void;
  onClose(): void;
}

/**
 * One pane's header bar: identity (glyph + inline-renamable title), the
 * badge cluster, and the window actions. Dumb by contract — every badge
 * value arrives settled; the only state here is the rename editor, which
 * means nothing while the header is unmounted.
 */
export function AgentPaneHeader({
  paneId,
  title,
  agentIcon,
  agentLabel,
  folded,
  focused,
  solo,
  activityView,
  now,
  ctxPct,
  paneLive,
  yolo,
  team,
  teams,
  onSetTeam,
  gitBadge,
  keyboardFocusEnabled,
  onSelect,
  onRename,
  onMinimize,
  onToggleFocus,
  onClose,
}: AgentPaneHeaderProps) {
  // Inline rename of the header title ([F11]); empty commit = back to auto.
  const rename = useInlineRename(
    (_key, name) => onRename(name),
    keyboardFocusEnabled,
  );
  // The same gesture for team membership, and the same "empty means clear"
  // convention: a blank commit takes the pane off its team, exactly as a
  // blank rename returns it to its automatic title.
  const teamRename = useInlineRename(
    (_key, spec) => onSetTeam?.(spec),
    keyboardFocusEnabled,
  );
  const teamEditing = teamRename.editing;
  return (
    <header className="pane__bar" onClick={folded ? onSelect : undefined}>
      {folded && (
        // The accessible expand handle (the header click is the pointer
        // convenience around it).
        <button
          type="button"
          className="pane__fold-chevron"
          aria-expanded={false}
          aria-label={`Expand ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
        >
          <ChevronDownIcon />
        </button>
      )}
      <div className="pane__identity">
        <span className="pane__agent" title={agentLabel}>
          <AgentGlyph icon={agentIcon} />
        </span>
        {rename.editing !== null ? (
          <input
            {...noAutoCorrect}
            {...rename.inputProps}
            className="pane__rename"
            autoFocus
            aria-label="Rename agent"
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="pane__title"
            title="Double-click to rename"
            onDoubleClick={() => rename.start(paneId, title)}
          >
            {title}
          </span>
        )}
      </div>
      <div className="pane__actions">
        {activityView && (
          // A dot for every state — the frame ladder carries attention now,
          // so the header stays at one density; words live in the tooltip.
          <Chip
            className={`pane__activity pane__activity--${activityView.tone}`}
            role="img"
            aria-label={activityView.label}
            title={`${activityView.label}${
              activityView.detail ? ` — ${activityView.detail}` : ""
            } · ${formatAge(activityView.at, now)}`}
            icon={<span className="pane__activity-dot" />}
          />
        )}
        {ctxPct !== undefined && paneLive && (
          <Chip
            className={`pane__ctx${
              contextLevel(ctxPct) === "ok"
                ? ""
                : ` usage-level--${contextLevel(ctxPct)}`
            }`}
            title={`Context ${Math.ceil(ctxPct)}% used`}
            label={`ctx ${Math.ceil(ctxPct)}%`}
          />
        )}
        {yolo && <YoloBadge className="pane__yolo" />}
        {teams &&
          // Before the branch chip: which teammate this is outranks which
          // branch it sits on when reading a deck mid-conversation, and the
          // narrow-header cascade drops from the right.
          //
          // The empty chip is the AFFORDANCE. A team has to start somewhere,
          // and a pane with no team has no badge to double-click — so the
          // placeholder stands in its place, and only while the feature is
          // switched on, which keeps it off the headers of everyone not
          // using teams.
          (teamEditing !== null ? (
            <input
              {...noAutoCorrect}
              {...teamRename.inputProps}
              className="pane__team-edit"
              autoFocus
              aria-label="Set team and role, as role@team"
              placeholder="role@team"
              onMouseDown={(e) => e.stopPropagation()}
            />
          ) : team ? (
            <span onDoubleClick={() => teamRename.start(paneId, formatTeamSpec(team))}>
              <TeamBadge className="pane__team" team={team.name} role={team.role} />
            </span>
          ) : (
            <Chip
              className="pane__team pane__team--empty"
              icon={<UsersIcon />}
              label="team"
              title="Double-click to put this agent on a team"
              onDoubleClick={() => teamRename.start(paneId, "")}
            />
          ))}
        {gitBadge && (
          <BranchBadge
            className="pane__branch"
            title={gitBadge.title}
            label={gitBadge.label}
          />
        )}
        {onMinimize && !focused && !folded && (
          <button
            type="button"
            // The modifier is load-bearing: the narrow-header cascade hides
            // minimize by this class (pane.css) while maximize stays.
            className="pane__action pane__action--minimize"
            onClick={onMinimize}
            title="Minimize agent"
            aria-label={`Minimize ${title}`}
          >
            <MinimizeIcon />
          </button>
        )}
        {!solo && !folded && (
          <button
            type="button"
            className="pane__action"
            onClick={onToggleFocus}
            title={focused ? "Restore" : "Maximize"}
            aria-label={focused ? `Restore ${title}` : `Maximize ${title}`}
          >
            {focused ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
        )}
        <CloseButton
          label={`Close ${title}`}
          onClick={(e) => {
            // Own click: closing a folded row must not also expand it.
            e.stopPropagation();
            onClose();
          }}
        />
      </div>
    </header>
  );
}
