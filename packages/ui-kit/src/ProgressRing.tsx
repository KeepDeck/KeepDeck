import type { CSSProperties, ReactNode } from "react";

export type ProgressRingTone = "warn" | "critical";

export interface ProgressRingProps {
  /** How full the ring is, 0–100. The caller clamps: what a reading MEANS
   * (and where it tops out) is the caller's to decide. */
  value: number;
  /** The ring's hue near a limit; none is the calm structural gray. */
  tone?: ProgressRingTone | null;
  /** A small mark drawn dead centre (an agent's glyph). */
  children?: ReactNode;
  /** Site class hook (spacing, size overrides). */
  className?: string;
  /** `ring` (default): a thin track filled along its band. `pie`: the
   *  sector itself filled solid inside an outline in the same hue — a full
   *  ring is a full disc, an empty one an outline. */
  shape?: "ring" | "pie";
}

/**
 * A circular progress ring — a thin track filled counter-clockwise to
 * `value`, with an optional mark in its middle. Changing `value` ANIMATES
 * the fill to the new reading (a registered `--progress-ring-fill`, see
 * progressRing.css) rather than jumping to it; reduced motion rests it.
 *
 * Decorative: the surface it sits in names what it measures (a title, an
 * aria-label), so the ring itself is hidden from assistive tech.
 */
export function ProgressRing({ value, tone, children, className, shape = "ring" }: ProgressRingProps) {
  return (
    <span
      className={["progress-ring", shape === "pie" && "progress-ring--pie", tone && `progress-ring--${tone}`, className]
        .filter(Boolean)
        .join(" ")}
      style={{ "--progress-ring-fill": value } as CSSProperties}
      aria-hidden
    >
      {children !== undefined && <span className="progress-ring__mark">{children}</span>}
    </span>
  );
}
