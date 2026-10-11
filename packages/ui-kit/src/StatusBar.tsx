import type { StatusRingTone } from "./StatusRing";

/** One painted stretch of a bar: a status hue, and its share of the whole
 * track, 0–100. */
export interface StatusBarPart {
  tone: Exclude<StatusRingTone, "none">;
  share: number;
}

export interface StatusBarProps {
  /** Left to right; what they leave of the track stays bare. */
  parts: readonly StatusBarPart[];
  /** What it says, for the pointer and assistive tech. */
  label: string;
  /** Beside words that already say it: a picture only, kept from assistive
   * tech, which would read it twice. */
  decorative?: boolean;
  /** Sizes it where it stands. */
  className?: string;
}

/**
 * How a whole splits by status, as one bar: each part painted in its status
 * hue (status.css, the rings' own), exactly as wide as its share — shares
 * are never stretched to fill the track, so what is not painted reads as
 * not yet started. A part keeps its node while its share moves, so it eases.
 */
export function StatusBar({ parts, label, decorative = false, className }: StatusBarProps) {
  const named = decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label, title: label };
  return (
    <span className={["status-bar", className].filter(Boolean).join(" ")} {...named}>
      {parts.map((part) => (
        <span key={part.tone} className={`status-bar__part status-bar__part--${part.tone}`} style={{ flexBasis: `${part.share}%` }} />
      ))}
    </span>
  );
}
