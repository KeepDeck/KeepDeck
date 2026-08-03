/**
 * The pane-chrome state badges, shared by the agent pane header and the
 * minimized stand-in so the two cannot drift apart: one component per state,
 * one canonical title/aria per state, sizes expressed through the shared Chip
 * anatomy (styled once in the host's chip.css). A site keeps only its own
 * class hook via `className` for layout extras (flex place, narrow-header
 * cascade, max-widths).
 */
import { Chip } from "./Chip.tsx";
import { BoltIcon, GitBranchIcon, PowerIcon } from "./icons.tsx";

/** One wording for the YOLO warning wherever the badge stands. */
export const YOLO_BADGE_TITLE = "YOLO mode — runs without permission prompts";

/** The mode's short accessible name (the badge is icon-only; assistive tech
 * gets this, sighted hover gets the fuller YOLO_BADGE_TITLE). */
export const YOLO_BADGE_LABEL = "YOLO mode";

/** One wording for the stopped stand-in marker wherever it stands. */
export const STOPPED_MARKER_TITLE = "Stopped — resume to run it";

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
 * The standing "runs without permission prompts" warning dot.
 *
 * `yolo-badge` is a NAME, not a style hook: the shape comes from
 * `chip--icon-only`, which Chip derives, and the site hook carries the layout.
 * No stylesheet selects it and none should — it is how this badge is found in
 * devtools and in the tests that pin its wording and its role. Its absence
 * from every .css file is not a sign that it is dead markup.
 */
export function YoloBadge({ size, className, decorative }: YoloBadgeProps) {
  return (
    <Chip
      tone="warn"
      size={size}
      className={["yolo-badge", className].filter(Boolean).join(" ")}
      icon={<BoltIcon />}
      title={YOLO_BADGE_TITLE}
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": YOLO_BADGE_LABEL })}
    />
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

export interface StoppedMarkerProps {
  /** Site class hook (the muted color, flex place). */
  className?: string;
}

/** The bare power glyph marking a stand-in whose pane has no process. Bare by
 * design: a suspended agent is a normal resting state, not a warning — the
 * site hook owns the muted color. */
export function StoppedMarker({ className }: StoppedMarkerProps) {
  return (
    <span className={className} title={STOPPED_MARKER_TITLE}>
      <PowerIcon />
    </span>
  );
}
