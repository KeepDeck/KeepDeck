/**
 * The run log's own presentation strings — the ANSI-wrapped lines the manager
 * writes into a session's terminal around the process's own output. Pure so
 * they're testable without a fake PTY; the manager encodes and forwards them.
 */

/** The command echo at the top of a run's log — the way a shell shows what it's
 * about to run. The Commands list only ever shows a preset's NAME, so the log
 * is where the actual command becomes visible. Newlines are normalized so a
 * multi-line script doesn't stair-step across the terminal grid. */
export function commandBanner(command: string): string {
  const echo = command.replace(/\r?\n/g, "\r\n");
  return `\x1b[90m[run] ${echo}\x1b[0m\r\n`;
}

/** The end-of-run note appended to the log. A run the user pulled the plug on
 * reads "[stopped]" — the kill signal's exit code would be noise; otherwise it
 * reports the process's own exit code when there is one. */
export function exitNote(opts: { stopped: boolean; code?: number | null }): string {
  const body = opts.stopped
    ? "[stopped]"
    : `[process exited${opts.code != null ? ` (${opts.code})` : ""}]`;
  return `\r\n\x1b[90m${body}\x1b[0m\r\n`;
}

/** The spawn-failure note — the OS error belongs in the session's own log, not
 * just a status chip, so the WHY (e.g. a deleted worktree dir named by the
 * error) stays visible. */
export function spawnFailedNote(message: string): string {
  return `\x1b[31mspawn failed: ${message}\x1b[0m\r\n`;
}
