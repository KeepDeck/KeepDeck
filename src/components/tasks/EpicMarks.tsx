/** What says a task is an epic, drawn one way wherever it shows: its chip
 * (a row, a card's head). Its progress is a ui-kit StatusBar. */

export function EpicChip({ text }: { text: string }) {
  return <span className="kd-tag tasks__epic-chip">{text}</span>;
}
