import { useMemo } from "react";

/** One group of rows under a heading — a scope's library. */
export interface LibraryNavGroup<Scope, Row> {
  label: string;
  scope: Scope;
  items: Row[];
  /** Whether the group takes a "+ New": a read-only tier does not. */
  canCreate: boolean;
}

/** What the nav says, per library — copy is presentation, and it lives in
 * this object rather than in the markup so a second library states its own
 * without touching the component. */
export interface LibraryNavCopy<Scope, Row> {
  /** The nav's accessible name: "Skills library". */
  ariaLabel: string;
  /** A stable key for a scope — a React key. */
  scopeKey(scope: Scope): string;
  /** The line under a row's name, or nothing. Called once per row per
   * list, not per render — the projection may read a whole file. */
  describe(row: Row): string | undefined;
  /** The "+ New" button's title for a scope. */
  createTitle(scope: Scope): string;
  /** What an empty group says once the list is known to be empty. */
  emptyCopy(scope: Scope): string;
}

interface LibraryNavProps<Scope, Row extends { name: string }> {
  groups: LibraryNavGroup<Scope, Row>[];
  copy: LibraryNavCopy<Scope, Row>;
  /** What an EMPTY group means right now. "unknown" covers both the first
   * read and a read that FAILED — with only a loading flag, a failed read let
   * the nav assert "Nothing here yet" beside a placeholder saying the library
   * could not be read. */
  emptyMeans: "loading" | "unknown" | "empty";
  /** A write is in flight. Rows go quiet with the editor's buttons:
   * navigating mid-delete bumped the epoch that the delete's own completion
   * checks, so the editor was left on an item that no longer existed. */
  busy: boolean;
  isActive(row: Row): boolean;
  onOpen(row: Row): void;
  onCreate(scope: Scope): void;
}

/** The library nav: scope groups of rows, each row answering "what is this
 * one" with its description right under the name. Shared by every library
 * dialog; the words are the copy's. */
export function LibraryNav<Scope, Row extends { name: string }>({
  groups,
  copy,
  emptyMeans,
  busy,
  isActive,
  onOpen,
  onCreate,
}: LibraryNavProps<Scope, Row>) {
  // Described once per list, not once per row per render: every keystroke in
  // the editor beside this nav re-renders it.
  const described = useMemo(() => {
    const byRow = new Map<Row, string | undefined>();
    for (const group of groups) {
      for (const row of group.items) byRow.set(row, copy.describe(row));
    }
    return byRow;
  }, [groups, copy]);

  return (
    <nav className="library__nav" aria-label={copy.ariaLabel}>
      {groups.map(({ label, scope, items, canCreate }) => (
        <div className="library__group" key={copy.scopeKey(scope)}>
          <div className="library__group-head">
            <span className="library__group-label">{label}</span>
            {canCreate && (
              <button
                type="button"
                className="library__new"
                onClick={() => onCreate(scope)}
                disabled={busy}
                title={copy.createTitle(scope)}
              >
                + New
              </button>
            )}
          </div>
          {items.map((row) => {
            const description = described.get(row);
            return (
              <button
                key={`${copy.scopeKey(scope)}:${row.name}`}
                type="button"
                className={`library__item${isActive(row) ? " library__item--active" : ""}`}
                aria-current={isActive(row) || undefined}
                disabled={busy}
                onClick={() => onOpen(row)}
              >
                <span className="library__item-name">{row.name}</span>
                {description && <span className="library__item-desc">{description}</span>}
              </button>
            );
          })}
          {items.length === 0 && (
            <div className="library__empty-group">
              {emptyMeans === "loading"
                ? "Loading…"
                : emptyMeans === "unknown"
                  ? "Not known — see the message above"
                  : copy.emptyCopy(scope)}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
