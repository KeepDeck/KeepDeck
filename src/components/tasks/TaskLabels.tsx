/** A task's labels as quiet words — on a card, a row, the open task. */
export function TaskLabels({ labels }: { labels: readonly string[] }) {
  return (
    <span className="tasks__labels">
      {labels.map((label) => (
        <span key={label} className="kd-tag">
          {label}
        </span>
      ))}
    </span>
  );
}
