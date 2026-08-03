import type { HTMLAttributes, ReactNode } from "react";

/**
 * The bordered pill used all over the chrome: branch badges, the YOLO
 * warning, the ctx meter, the top-bar usage chips, history and skills
 * pills. One shared anatomy (styled once in the host's chip.css, like every
 * ui-kit primitive) so the sites cannot drift apart; a site keeps only its
 * own class hook via `className` for layout extras (max-widths, container
 * queries, hover states).
 *
 * Simple chips pass `icon` + `label`; the label slot ellipsizes. Composite
 * content (the usage chip's window list) goes through `children`, rendered
 * raw. A chip with `onClick` renders a <button>, otherwise a <span>.
 *
 * A chip given an icon and nothing else collapses to the round icon-only
 * badge on its own (`chip--icon-only`) — the YOLO dot and the pane header's
 * activity dot are both that, and both used to restate the shape themselves.
 */
export interface ChipProps
  extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  /** Leading glyph; decorative (aria-hidden) — the label names the chip. */
  icon?: ReactNode;
  /** Color intent; neutral is the default structural gray. */
  tone?: "neutral" | "warn" | "error";
  /** md = the 22px header/top-bar chip (default); sm = the 20px tray chip;
   * inline = a padding-sized pill riding a text row (history, skills). */
  size?: "md" | "sm" | "inline";
  /** Text content, wrapped in the ellipsizing label slot. */
  label?: ReactNode;
  /** Composite content, rendered raw (no label wrapper). */
  children?: ReactNode;
}

export function Chip({
  icon,
  tone = "neutral",
  size = "md",
  label,
  children,
  className,
  ...rest
}: ChipProps) {
  // A chip carrying nothing but its glyph IS the round icon-only badge — the
  // pill's side padding would only push that glyph off centre. Derived rather
  // than asked for, because every site that wanted the shape had hand-rolled
  // the same three declarations, and a prop is one more thing to forget: the
  // shape now arrives with the content that calls for it. chip.css owns what
  // it looks like.
  const iconOnly =
    icon !== undefined && label === undefined && children === undefined;
  const classes = [
    "chip",
    size !== "md" ? `chip--${size}` : "",
    tone !== "neutral" ? `chip--${tone}` : "",
    iconOnly ? "chip--icon-only" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const content = (
    <>
      {icon !== undefined && (
        <span className="chip__icon" aria-hidden>
          {icon}
        </span>
      )}
      {label !== undefined && <span className="chip__label">{label}</span>}
      {children}
    </>
  );
  if (rest.onClick !== undefined) {
    return (
      <button type="button" className={classes} {...rest}>
        {content}
      </button>
    );
  }
  return (
    <span className={classes} {...rest}>
      {content}
    </span>
  );
}
