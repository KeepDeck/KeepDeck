import { TERMINAL_COUNTS, TerminalCountTiles } from "./TerminalCountTiles";

interface WorkspaceSetupProps {
  /** Add this many agents to an existing (currently empty) workspace. */
  onPick(count: number): void;
}

/**
 * Shown when a workspace has no panes (e.g. after closing all its agents): pick
 * how many agents to add (of the workspace's existing type / directory).
 */
export function WorkspaceSetup({ onPick }: WorkspaceSetupProps) {
  return (
    <div className="setup">
      <h2 className="setup__title">How many agents?</h2>
      <p className="setup__hint">Add agents to this workspace.</p>
      <TerminalCountTiles counts={TERMINAL_COUNTS} value={null} onPick={onPick} />
    </div>
  );
}
