/** A titled list of standing conditions among the settings rows, each line
 * selectable so it can be copied. Nothing while there is none. */
export function HintList({ title, lines }: { title: string; lines: readonly { key: string; text: string }[] }) {
  if (lines.length === 0) return null;
  return (
    <span className="settings__hint kd-selectable">
      {title}
      {lines.map((line) => (
        <span key={line.key} className="settings__refusal">
          {line.text}
        </span>
      ))}
    </span>
  );
}
