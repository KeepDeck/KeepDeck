/**
 * The POSIX shell program KeepDeck wraps the Kimi setup server in.
 *
 * Its own file because it is a PROGRAM, not a helper: forty lines of `sh`
 * with traps, a watcher subshell and a TERM→KILL escalation, none of which a
 * TypeScript test can execute. Keeping it beside the process lifecycle hid
 * that — a reader of `serverManager` met it as one more function, and a
 * shell linter never saw it at all. Here it can be `sh -n`-checked (the
 * suite does) and read as what it is.
 */

/** How often the spawn wrapper checks that its parent (the KeepDeck process)
 * is still alive. See setupServerWrapperScript's docblock for the design. */
const WATCHDOG_POLL_SECONDS = 5;

/** The spawn wrapper script. Exported (not inline) so the test suite can
 * syntax-check it with `sh -n` instead of only asserting substrings.
 *
 * Design:
 * - The watcher subshell polls its parent (the KeepDeck process) and kills
 *   the server when the parent is gone — `kimi web` survives SIGHUP, so a
 *   hard host crash (SIGKILL, power loss) would otherwise orphan a live
 *   server with an unrecoverable token. `kill -0` checks pid EXISTENCE, so
 *   the poll also compares the parent's start time (`ps -o lstart=`): a
 *   recycled pid fails the identity check. A failed `ps` read skips the
 *   comparison rather than risking a spurious kill.
 * - A PTY-master close delivers SIGHUP to the foreground process group, so
 *   the wrapper traps HUP to stay alive long enough to finish the teardown;
 *   the TERM→KILL escalation mirrors the PTY close contract because the
 *   server can take seconds to honor a bare TERM.
 * - The watcher's own `sleep` children are reaped via TERM/EXIT traps —
 *   otherwise a killed watcher leaves a sleep holding the PTY slave open,
 *   delaying EOF (and the exit event) past the PTY's kill grace.
 * - The main shell `wait`s on the server and re-exits with its status, so a
 *   server that dies on its own produces the honest "exited before it
 *   became ready" event instead of a misleading startup timeout. The
 *   graceful path needs no watchdog: closing the session signals the whole
 *   process group.
 *
 * `--debug-endpoints` is what exposes the `/api/v1/debug` surface the
 * companion installer talks to. It is a DEBUG flag of another program — the
 * least-contracted surface Kimi ships, and the reason a headless
 * `kimi plugin install/enable` is the first thing worth asking upstream for. */
export function setupServerWrapperScript(): string {
  return `trap "" HUP
parent=$PPID
started=$(ps -o lstart= -p "$parent" 2>/dev/null)
kimi web --no-open --host 127.0.0.1 --port 0 --log-level silent --debug-endpoints &
child=$!
(
  slp=
  trap 'kill "$slp" 2>/dev/null' EXIT
  trap 'exit 0' TERM
  while kill -0 "$parent" 2>/dev/null; do
    now=$(ps -o lstart= -p "$parent" 2>/dev/null)
    [ -n "$started" ] && [ -n "$now" ] && [ "$now" != "$started" ] && break
    sleep ${WATCHDOG_POLL_SECONDS} &
    slp=$!
    wait "$slp" 2>/dev/null
  done
  kill "$child" 2>/dev/null
  sleep 3 &
  slp=$!
  wait "$slp" 2>/dev/null
  kill -9 "$child" 2>/dev/null
) &
watcher=$!
wait "$child" 2>/dev/null
code=$?
kill "$watcher" 2>/dev/null
exit "$code"`;
}
