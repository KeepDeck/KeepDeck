import { gridTracks, paneGrid } from "../layout";

/** Terminal-count presets for a new workspace (all within MAX_PANES). */
const TERMINAL_COUNTS = [1, 2, 4, 6, 8, 12, 16];

interface WorkspaceSetupProps {
  /** Start the workspace with this many terminals. */
  onPick(count: number): void;
}

/**
 * Empty-workspace setup: pick how many terminals to start with. A deliberately
 * minimal take on the reference's new-workspace screen — just the layout
 * picker, no recent folders / presets / path picker.
 */
export function WorkspaceSetup({ onPick }: WorkspaceSetupProps) {
  return (
    <div className="setup">
      <h2 className="setup__title">How many terminals?</h2>
      <p className="setup__hint">Pick a layout to start this workspace.</p>
      <div className="setup__tiles">
        {TERMINAL_COUNTS.map((count) => {
          const grid = paneGrid(count);
          const cells = grid.columns * grid.rows;
          return (
            <button
              key={count}
              type="button"
              className="setup__tile"
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
    </div>
  );
}
