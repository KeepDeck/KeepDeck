import type { ActivityBadge } from "../../domain/status";
import { contextLevel, formatAge } from "../../domain/usage";
import { noAutoCorrect } from "../../ui/inputProps";
import { useInlineRename } from "../../ui/useInlineRename";
import { MaximizeIcon, MinimizeIcon, RestoreIcon } from "../../ui/icons";
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
  /** Whether the badge must also name the team — true where this deck runs
   * more than one, which is the only case where a role alone is not an
   * identity. A settled fact about the WHOLE deck: a header sees one pane. */
  showTeamName?: boolean;
  gitBadge?: GitBadge | null;
  /** False while a modal or covering dock owns keyboard interaction — an
   * inline rename must not be left in flight underneath one. */
  keyboardFocusEnabled: boolean;
  onRename(name: string): void;
  /** Open the team this pane is on. Absent while the feature is off, which
   * is also when no badge is rendered — the two travel together. */
  onOpenTeam?(name: string): void;
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
  focused,
  solo,
  activityView,
  now,
  ctxPct,
  paneLive,
  yolo,
  team,
  showTeamName,
  gitBadge,
  keyboardFocusEnabled,
  onRename,
  onOpenTeam,
  onMinimize,
  onToggleFocus,
  onClose,
}: AgentPaneHeaderProps) {
  // Inline rename of the header title ([F11]); empty commit = back to auto.
  const rename = useInlineRename(
    (_key, name) => onRename(name),
    keyboardFocusEnabled,
  );
  return (
    <header className="pane__bar">
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
        {team && (
          // The way IN to this pane's team, and the only one that scales: a
          // workspace may run several, so the bar's button always makes a
          // new one and each existing team is opened from a member wearing
          // it — which is where somebody thinking about a team is already
          // looking.
          //
          // It still settles nothing itself. A header can say WHICH teammate
          // this is; it cannot answer "are these roles unique", which is the
          // question that decides whether a team works, and that question
          // needs the whole roster.
          //
          // Before the branch chip: which teammate this is outranks which
          // branch it sits on when reading a deck mid-conversation, and the
          // narrow-header cascade drops from the right.
          <button
            type="button"
            className="pane__team-open"
            onClick={() => onOpenTeam?.(team.name)}
            title={`Open team “${team.name}” — who is on it and what each is called`}
            aria-label={`Open team ${team.name}`}
          >
            <TeamBadge
              className="pane__team"
              team={team.name}
              role={team.role}
              showTeamName={showTeamName}
              decorative
            />
          </button>
        )}
        {gitBadge && (
          <BranchBadge
            className="pane__branch"
            title={gitBadge.title}
            label={gitBadge.label}
          />
        )}
        {onMinimize && !focused && (
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
        {!solo && (
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
        <CloseButton label={`Close ${title}`} onClick={onClose} />
      </div>
    </header>
  );
}
