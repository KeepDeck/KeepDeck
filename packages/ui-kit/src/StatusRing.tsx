import { ProgressRing } from "./ProgressRing";

/** A status's hue — the app's status vocabulary (status.css), plus none. */
export type StatusRingTone = "working" | "waiting" | "failed" | "done" | "none";

export interface StatusRingProps {
  /** How far along, 0–100: a place on a ladder, not a live reading. */
  fill: number;
  tone: StatusRingTone;
  /** Struck through: stopped, waiting on something else. */
  barred?: boolean;
  /** A dashed outline: not yet on the ladder at all (parked). */
  dashed?: boolean;
  /** What it says, for the pointer and assistive tech. */
  label: string;
  /** Beside the word it pictures ("In progress"): a picture only, kept
   * from assistive tech, which would read the word twice. */
  decorative?: boolean;
}

/**
 * A status as a small pie filled by how far along it is — the ONE ring
 * language of the app: it is a `ProgressRing` in its `pie` shape, coloured
 * by the status hues and sized for a line of text, with a bar for
 * "stopped". A place on a ladder rests (none of the status dots' rhythms,
 * decision 2026-10-04); a move along it eases — fill and hue glide.
 */
export function StatusRing({ fill, tone, barred = false, dashed = false, label, decorative = false }: StatusRingProps) {
  const named = decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label, title: label };
  return (
    <span className="status-ring-box" {...named}>
      <ProgressRing
        shape="pie"
        value={fill}
        className={["status-ring", `status-ring--${tone}`, barred && "status-ring--barred", dashed && "status-ring--dashed"]
          .filter(Boolean)
          .join(" ")}
      >
        <span className="status-ring__bar" />
      </ProgressRing>
    </span>
  );
}
