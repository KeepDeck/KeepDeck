/**
 * The pane-chrome state badges, shared by the agent pane header and the
 * minimized stand-in so the two cannot drift apart: one component per state,
 * one canonical title/aria per state, sizes expressed through the shared Chip
 * anatomy (styled once in the host's chip.css). A site keeps only its own
 * class hook via `className` for layout extras (flex place, narrow-header
 * cascade, max-widths).
 */
import { teamBadgeTitle } from "./teamWords";
import { Chip } from "./Chip.tsx";
import { BoltIcon, GitBranchIcon } from "./icons.tsx";

/** One wording for the YOLO warning wherever the badge stands. */
export const YOLO_BADGE_TITLE = "YOLO mode — runs without permission prompts";

/** The mode's short accessible name (the badge is icon-only; assistive tech
 * gets this, sighted hover gets the fuller YOLO_BADGE_TITLE). */
export const YOLO_BADGE_LABEL = "YOLO mode";


export interface YoloBadgeProps {
  /** md in the pane header (default), sm in the minimized stand-in. */
  size?: "md" | "sm";
  /** Site class hook (cascade hiding, flex place). */
  className?: string;
  /** True inside an already-labeled control (the tray's restore button): the
   * badge is decorative there; the header's stands alone and names itself. */
  decorative?: boolean;
}

/**
 * The standing "runs without permission prompts" mark: the bolt, bare. It
 * was a ringed warn chip — a fourth shape in a header already mixing a dot,
 * text and icon buttons — and now it is one more glyph among the header's
 * glyphs, in the warn hue that says what it warns of. Styled once by the
 * host (badges.css `.yolo-mark`); the site hook keeps only its place.
 */
export function YoloBadge({ size, className, decorative }: YoloBadgeProps) {
  return (
    <span
      className={["yolo-mark", size === "sm" && "yolo-mark--sm", className]
        .filter(Boolean)
        .join(" ")}
      title={YOLO_BADGE_TITLE}
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": YOLO_BADGE_LABEL })}
    >
      <BoltIcon />
    </span>
  );
}

export interface BranchBadgeProps {
  /** Branch name shown in the pill. */
  label: string;
  /** Full branch wording for the native tooltip (an ellipsized label stays
   * readable); omitted where a custom tooltip replaces native titles. */
  title?: string;
  /** md in the pane header (default), sm in the minimized stand-in. */
  size?: "md" | "sm";
  /** Site class hook (max-width, container queries). */
  className?: string;
  /** True inside an already-labeled control (the tray's restore button). */
  decorative?: boolean;
}

/** The currently observed git branch, as the bordered chip. */
export function BranchBadge({
  label,
  title,
  size,
  className,
  decorative,
}: BranchBadgeProps) {
  return (
    <Chip
      size={size}
      className={className}
      icon={<GitBranchIcon />}
      label={label}
      title={title}
      aria-hidden={decorative || undefined}
    />
  );
}




export { teamBadgeTitle };
