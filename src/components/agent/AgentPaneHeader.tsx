import {
  PANE_HEADER_WORDS,
  paneControlsView,
  type PaneHeaderView,
} from "../../presentation/paneHeaderView";
import { RenameInput } from "../../ui/RenameInput";
import { useInlineRename } from "../../ui/useInlineRename";
import { MaximizeIcon, MinimizeIcon, RestoreIcon } from "../../ui/icons";
import { YoloBadge } from "../../ui/badges";
import { CloseButton } from "../../ui/CloseButton";
import { AgentGlyph, type AgentGlyphIcon } from "../../ui/AgentGlyph";

export interface AgentPaneHeaderProps {
  /** Rename key — the editor survives a title change to the same pane. */
  paneId: string;
  title: string;
  agentIcon?: AgentGlyphIcon | null;
  agentLabel?: string;
  focused: boolean;
  solo: boolean;
  /** What the header shows — status, state word, role, context — settled
   * by paneHeaderView; this header only maps it. */
  view: PaneHeaderView;
  yolo?: boolean;
  /** False while a modal or covering dock owns keyboard interaction — an
   * inline rename must not be left in flight underneath one. */
  keyboardFocusEnabled: boolean;
  onRename(name: string): void;
  onMinimize?(): void;
  onToggleFocus(): void;
  onClose(): void;
}

/**
 * One pane's header bar: the status dot, identity (glyph, inline-renamable
 * title, role), and the cluster — the state in words when it needs a
 * person, YOLO, context, and the window actions. Dumb by contract — the
 * view arrives settled; the only state here is the rename editor, which
 * means nothing while the header is unmounted.
 */
export function AgentPaneHeader({
  paneId,
  title,
  agentIcon,
  agentLabel,
  focused,
  solo,
  view,
  yolo,
  keyboardFocusEnabled,
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
  const controls = paneControlsView({ title, focused, solo, canMinimize: onMinimize !== undefined });
  return (
    <header className="pane__bar">
      <div className="pane__identity">
        {view.status && (
          <span
            className={`pane__status pane__status--${view.status.tone}`}
            role="img"
            aria-label={view.status.label}
            title={view.status.tooltip}
          />
        )}
        <span className="pane__agent" title={agentLabel}>
          <AgentGlyph icon={agentIcon} />
        </span>
        {rename.editing !== null ? (
          <RenameInput
            rename={rename}
            className="pane__rename"
            label={PANE_HEADER_WORDS.renameField}
            contained
          />
        ) : (
          <span
            className="pane__title"
            title={PANE_HEADER_WORDS.renameHint}
            onDoubleClick={() => rename.start(paneId, title)}
          >
            {title}
          </span>
        )}
        {view.role && (
          <span className="pane__role" title={view.role.title}>
            {view.role.text}
          </span>
        )}
      </div>
      <div className="pane__actions">
        {view.status && view.stateWord && (
          <span className={`pane__state pane__state--${view.status.tone}`}>
            {view.stateWord}
          </span>
        )}
        {yolo && <YoloBadge className="pane__yolo" />}
        {view.ctx && (
          <span className={`pane__ctx pane__ctx--${view.ctx.level}`} title={view.ctx.title}>
            {view.ctx.label}
          </span>
        )}
        {controls.minimize && (
          <button
            type="button"
            // The modifier is load-bearing: the narrow-header cascade hides
            // minimize by this class (pane.css) while maximize stays.
            className="pane__action pane__action--minimize"
            onClick={onMinimize}
            title={controls.minimize.tip}
            aria-label={controls.minimize.label}
          >
            <MinimizeIcon />
          </button>
        )}
        {controls.spotlight && (
          <button
            type="button"
            className="pane__action"
            onClick={onToggleFocus}
            title={controls.spotlight.tip}
            aria-label={controls.spotlight.label}
          >
            {controls.spotlight.restore ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
        )}
        <CloseButton label={controls.close.label} onClick={onClose} />
      </div>
    </header>
  );
}
