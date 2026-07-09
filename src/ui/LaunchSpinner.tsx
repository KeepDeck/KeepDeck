/**
 * The "still coming up" indicator: a thin indeterminate slide bar pinned to the
 * top of its positioned container, over three pulsing dots. Shared by the
 * worktree-creating card (`AgentPane`) and the terminal launch overlay
 * (`TerminalPane`) so both phases of bringing a pane alive read as one
 * continuous animation. Purely decorative — the surrounding element carries the
 * status role and label.
 */
export function LaunchSpinner() {
  return (
    <>
      <span className="pane__provision-bar" aria-hidden />
      <span className="pane__provision-pulse" aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </>
  );
}
