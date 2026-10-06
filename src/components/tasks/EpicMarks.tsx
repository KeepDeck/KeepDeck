/** What says a task is an epic, drawn one way wherever it shows: its chip
 * (a row, a card's head) and its progress bar (a row, its card). */

export function EpicChip({ text }: { text: string }) {
  return <span className="kd-tag tasks__epic-chip">{text}</span>;
}

/** The bar's fill, 0–100; `className` sizes it where it stands. */
export function EpicBar({ fill, className }: { fill: number; className?: string }) {
  return (
    <span className={["tasks__epic-bar", className].filter(Boolean).join(" ")} aria-hidden>
      <span className="tasks__epic-fill" style={{ width: `${fill}%` }} />
    </span>
  );
}
