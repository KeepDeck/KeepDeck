import { GitBranchIcon, RestoreUpIcon } from "../../ui/icons";
import type { GitBadge } from "../../ui/gitBadge";

interface MinimizedItemProps {
  /** `chip` = a compact pill for the tray; `bar` = a full-width header bar for
   * the strip. */
  variant: "chip" | "bar";
  title: string;
  /** The agent's live branch badge, when its cwd is a known git HEAD. */
  gitBadge?: GitBadge | null;
  /** aria-label and tooltip for the whole control, e.g. "Restore Claude 1". */
  label: string;
  onClick(): void;
}

/**
 * The stand-in a minimized agent shows below the grid — a tray chip or a folded
 * strip bar. It carries no terminal; the real pane is hidden but still mounted
 * in the grid, so restoring is instant (no re-attach, no scrollback replay).
 */
export function MinimizedItem({
  variant,
  title,
  gitBadge,
  label,
  onClick,
}: MinimizedItemProps) {
  return (
    <button
      type="button"
      className={`minimized minimized--${variant}`}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <span className="minimized__title">{title}</span>
      {gitBadge && (
        <span className="minimized__branch" title={gitBadge.title}>
          <GitBranchIcon />
          <span className="minimized__branch-label">{gitBadge.label}</span>
        </span>
      )}
      <span className="minimized__restore" aria-hidden>
        <RestoreUpIcon />
      </span>
    </button>
  );
}
