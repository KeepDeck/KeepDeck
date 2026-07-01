import { gridTracks, paneGrid } from "../../domain/layout";

/** Terminal-count presets (all within MAX_PANES). */
export const TERMINAL_COUNTS = [1, 2, 4, 6, 8, 12, 16];

/** Wizard presets: TERMINAL_COUNTS plus a leading "None" (0) for creating an
 * empty workspace and adding agents later ([F15]). */
export const WORKSPACE_COUNTS = [0, ...TERMINAL_COUNTS];

interface TerminalCountTilesProps {
  counts: number[];
  /** Highlighted count, or null when the tiles act as immediate actions. */
  value: number | null;
  onPick(count: number): void;
}

/** A row of layout tiles, each previewing the grid for that pane count. */
export function TerminalCountTiles({
  counts,
  value,
  onPick,
}: TerminalCountTilesProps) {
  return (
    <div className="setup__tiles">
      {counts.map((count) => {
        // paneGrid is 1..=MAX_PANES; the "None" (0) tile previews a single empty
        // cell instead ([F15]).
        const grid = count > 0 ? paneGrid(count) : { columns: 1, rows: 1 };
        const cells = grid.columns * grid.rows;
        return (
          <button
            key={count}
            type="button"
            className={`setup__tile${count === value ? " setup__tile--active" : ""}`}
            onClick={() => onPick(count)}
            aria-label={
              count === 0
                ? "No agents (empty workspace)"
                : `${count} terminal${count === 1 ? "" : "s"}`
            }
          >
            <span
              className="setup__preview"
              style={{
                gridTemplateColumns: gridTracks(grid.columns),
                gridTemplateRows: gridTracks(grid.rows),
              }}
            >
              {Array.from({ length: cells }).map((_, i) => (
                <span
                  key={i}
                  className={`setup__cell${i < count ? " setup__cell--on" : ""}`}
                />
              ))}
            </span>
            <span className="setup__count">{count === 0 ? "None" : count}</span>
          </button>
        );
      })}
    </div>
  );
}
