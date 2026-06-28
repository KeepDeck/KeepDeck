import { gridTracks, paneGrid } from "../layout";

/** Terminal-count presets (all within MAX_PANES). */
export const TERMINAL_COUNTS = [1, 2, 4, 6, 8, 12, 16];

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
        const grid = paneGrid(count);
        const cells = grid.columns * grid.rows;
        return (
          <button
            key={count}
            type="button"
            className={`setup__tile${count === value ? " setup__tile--active" : ""}`}
            onClick={() => onPick(count)}
            aria-label={`${count} terminal${count === 1 ? "" : "s"}`}
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
            <span className="setup__count">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
