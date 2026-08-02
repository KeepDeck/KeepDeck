import type { ActivityBadge } from "../../domain/status";
import { contextLevel, formatAge } from "../../domain/usage";
import { noAutoCorrect } from "../../ui/inputProps";
import { useInlineRename } from "../../ui/useInlineRename";
import {
  ChevronDownIcon,
  MaximizeIcon,
  MinimizeIcon,
  RestoreIcon,
} from "../../ui/icons";
import { BranchBadge, YoloBadge } from "../../ui/badges";
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
  gitBadge?: GitBadge | null;
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
  gitBadge,
  onSelect,
  onRename,
  onMinimize,
  onToggleFocus,
  onClose,
}: AgentPaneHeaderProps) {
  // Inline rename of the header title ([F11]); empty commit = back to auto.
  const rename = useInlineRename((_key, name) => onRename(name));
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
