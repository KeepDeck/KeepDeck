/**
 * The pane-chrome state badges, shared by the agent pane header and the
 * minimized stand-in so the two cannot drift apart: one component per state,
 * one canonical title/aria per state, sizes expressed through the shared Chip
 * anatomy (styled once in the host's chip.css). A site keeps only its own
 * class hook via `className` for layout extras (flex place, narrow-header
 * cascade, max-widths).
 */
import { Chip } from "./Chip.tsx";
import { BoltIcon, GitBranchIcon, PowerIcon, UsersIcon } from "./icons.tsx";

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

/** One wording for the team badge wherever it stands. */
export function teamBadgeTitle(team: string, role: string): string {
  return `${role} on team ${team} — teammates address it by this role`;
}

export interface TeamBadgeProps {
  /** The team's name. */
  team: string;
  /** How teammates address this pane. */
  role: string;
  /** Name the team beside the role. Pass it where the deck runs MORE than
   * one: the caller knows that, the badge cannot. */
  showTeamName?: boolean;
  /** md in the pane header (default), sm in the minimized stand-in. */
  size?: "md" | "sm";
  /** Site class hook (max-width, container queries). */
  className?: string;
  /** True inside an already-labeled control. */
  decorative?: boolean;
}

/**
 * The pane's place on a team, as the bordered chip.
 *
 * The ROLE leads, because the role is the address: it is what teammates
 * write on a message and what a person needs to read a conversation. On a
 * deck running one team that is the whole identity, and the team name would
 * be the same word under every pane — a label that repeats itself carries
 * nothing, and this header sheds chips at breakpoints rather than spend
 * width on nothing.
 *
 * Running several, the role stops being an identity — two teams have a
 * `lead` each and the deck shows no way to tell them apart. So the caller
 * asks for the team, and it follows the role, dimmed: a qualifier on the
 * address, not a second address. In that order on purpose — cut short by a
 * narrow header, a clipped team ("ap…" vs "we…") still tells the teams
 * apart, while a clipped role would not tell impl-1 from impl-2.
 */
export function TeamBadge({
  team,
  role,
  showTeamName,
  size,
  className,
  decorative,
}: TeamBadgeProps) {
  return (
    <Chip
      size={size}
      className={className}
      icon={<UsersIcon />}
      label={
        showTeamName ? (
          <>
            {role}
            <span className="team-badge__team"> · {team}</span>
          </>
        ) : (
          role
        )
      }
      title={teamBadgeTitle(team, role)}
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
