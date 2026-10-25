/**
 * WHICH codex process a pane's TUI talks to — the one rule every launch of a
 * pane obeys, a plan's and a bare one's alike.
 *
 * A remote pane attaches to the server the host provisioned on the box
 * (`--remote <endpoint>`): codex runs HERE as a thin client, the agent brain
 * and its tool calls run there.
 *
 * A local pane runs its OWN app-server, in the pane's process. From 0.157 a
 * plain `codex` attaches to the user's shared background daemon instead
 * (`DaemonAutoStart`, stable and on by default), and the daemon runs the
 * pane's hooks and MCP children outside the pane's terminal session, where
 * the host's origin check cannot vouch for them: the pane would go dark.
 * Until now a pane stayed off the daemon only because any `-c` outside a
 * short allowlist (boolean `features.*` toggles and two other keys)
 * disqualifies a launch from it (codex `tui/src/daemon_startup.rs`): a side
 * effect, not a decision. `--no-daemon` states it, and codex has had the flag
 * since 0.156.
 *
 * It is never added beside `--remote`: codex refuses the pair outright
 * (`tui/src/startup_orchestration.rs`). Nor with an unknown or older
 * release: a flag codex does not know aborts the launch, so no evidence
 * means no flag, and such a pane keeps the `-c` that kept it off the daemon
 * before. Global like `-c`, so it precedes the `resume`/`fork` subcommand
 * (codex keeps it there: `cli/src/main.rs`, resume_and_fork_preserve_no_daemon).
 */
import type { SpawnPlanInput } from "@keepdeck/plugin-api";
import { releasedSince } from "./version";

/** The first codex release with `--no-daemon`. */
const NO_DAEMON_SINCE: readonly number[] = [0, 156, 0];

export function processArgs(
  input: Pick<SpawnPlanInput, "target" | "cliVersion">,
): string[] {
  if (input.target?.kind === "nativeServer") return ["--remote", input.target.endpoint];
  return releasedSince(input.cliVersion, NO_DAEMON_SINCE) === true ? ["--no-daemon"] : [];
}
