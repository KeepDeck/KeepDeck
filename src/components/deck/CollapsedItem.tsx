import { ChevronDownIcon, GitBranchIcon, RestoreUpIcon } from "../../ui/icons";
import type { GitBadge } from "../../ui/gitBadge";

interface CollapsedItemProps {
  /** `chip` = a compact pill for the tray; `bar` = a full-width header bar for
   * the strip and the list. */
  variant: "chip" | "bar";
  /** What activating the item does: `restore` brings a minimized agent back
   * (tray/strip); `expand` opens a folded list row. Picks the trailing/leading
   * glyph, nothing else. */
  action: "restore" | "expand";
  title: string;
  /** The agent's live branch badge, when its cwd is a known git HEAD. */
  gitBadge?: GitBadge | null;
  /** aria-label and tooltip for the whole control, e.g. "Restore Claude 1". */
  label: string;
  onClick(): void;
}

/**
 * The stand-in an agent shows while it's minimized out of the grid — a tray
 * chip, a folded strip bar, or a collapsed list row. It carries no terminal;
 * the PTY runs on in the manager and re-mounts when the agent is restored.
 */
export function CollapsedItem({
  variant,
  action,
  title,
  gitBadge,
  label,
  onClick,
}: CollapsedItemProps) {
  return (
    <button
      type="button"
      className={`collapsed collapsed--${variant}`}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {action === "expand" && (
        <span className="collapsed__chevron" aria-hidden>
          <ChevronDownIcon />
        </span>
      )}
      <span className="collapsed__title">{title}</span>
      {gitBadge && (
        <span className="collapsed__branch" title={gitBadge.title}>
          <GitBranchIcon />
          <span className="collapsed__branch-label">{gitBadge.label}</span>
        </span>
      )}
      {action === "restore" && (
        <span className="collapsed__restore" aria-hidden>
          <RestoreUpIcon />
        </span>
      )}
    </button>
  );
}
