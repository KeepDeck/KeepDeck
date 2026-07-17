import {
  baseName,
  codeLabel,
  dirName,
  type ChangeRow,
} from "../domain/status";

/**
 * The one changed-path row and its section wrapper — shared by the Changes
 * list, the History drill, and the peek's sibling rail, so a file reads the
 * same everywhere: the one-letter code colored by what happened, then the
 * dimmed directory and the name.
 */

/** A full-width click target opening (or switching to) the row's diff.
 * `current` marks the row already open in the peek. */
export function FileRow({
  row,
  current,
  onOpen,
}: {
  row: ChangeRow;
  current?: ChangeRow;
  onOpen: (row: ChangeRow) => void;
}) {
  // The same path can sit in two sections (staged AND edited again) — a row
  // is "the open one" only when the kind matches too.
  const active =
    current !== undefined &&
    current.path === row.path &&
    current.kind === row.kind;
  return (
    <button
      type="button"
      className={`git__row${active ? " git__row--on" : ""}`}
      onClick={() => onOpen(row)}
      title={`${row.path} — ${codeLabel(row.code)}`}
      aria-current={active || undefined}
    >
      <span
        className={`git__code git__code--${row.kind === "conflicted" ? "conflicted" : row.code === "D" ? "del" : row.kind}`}
        aria-hidden
      >
        {row.code}
      </span>
      <span className="git__file">
        {dirName(row.path) && (
          <span className="git__dir">{dirName(row.path)}</span>
        )}
        <span className="git__base">{baseName(row.path)}</span>
      </span>
    </button>
  );
}

/** One section (Staged / Changes / …): a header with the count, then rows.
 * Renders nothing when empty — absent sections don't take up rail space. */
export function FileSection({
  label,
  rows,
  current,
  onOpen,
}: {
  label: string;
  rows: ChangeRow[];
  current?: ChangeRow;
  onOpen: (row: ChangeRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="git__section">
      <div className="git__sechead">
        {label}
        <span className="git__seccount">{rows.length}</span>
      </div>
      {rows.map((row) => (
        <FileRow
          key={`${row.kind}:${row.path}`}
          row={row}
          current={current}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
