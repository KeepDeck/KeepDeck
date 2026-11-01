import type { AgentPermissionMode, AgentStatusEvent } from "@keepdeck/plugin-api";

/**
 * The mode a pane's agent last said it runs in — its own word, a policy's
 * downgrade and a switch inside the CLI included. Runtime-only, like the
 * activity: it describes one process, and the next process starts over from
 * its launch.
 */
export interface PaneMode {
  readonly mode: AgentPermissionMode;
  /** When the agent said it — the report's own time, so a record that
   * trails the hook lane cannot undo a newer word. */
  readonly at: number;
}

/** Fold one mode report into the pane's mode. The latest report wins, a
 * repeat of the same mode included — it moves the time forward, so a record
 * that trails it can no longer undo it. One older than the report in hand is
 * that trailing echo, and changes nothing: the SAME object comes back. */
export function reduceMode(
  current: PaneMode | null,
  event: Extract<AgentStatusEvent, { kind: "permission-mode" }>,
): PaneMode {
  if (current !== null && event.at < current.at) return current;
  return { mode: event.mode, at: event.at };
}
