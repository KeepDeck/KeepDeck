import { invoke } from "@tauri-apps/api/core";
import type { PluginExecOutcome, PluginExecRequest } from "@keepdeck/plugin-api";

/**
 * Hand one bounded, terminal-less run to the host (mirrors the Rust
 * `exec_run_once`).
 *
 * Authorisation is NOT here: the capability gate has already decided that
 * this plugin may run this command, by the same rule that gates spawning a
 * session with it. What the host still refuses on its own — a path instead
 * of a command name, and loader-controlling environment — comes back as a
 * rejection, and the caller treats it as "the run did not happen".
 */
export async function execRunOnce(
  request: PluginExecRequest,
): Promise<PluginExecOutcome> {
  return await invoke<PluginExecOutcome>("exec_run_once", {
    key: request.key,
    command: request.command,
    args: request.args ?? [],
    env: request.env ?? [],
  });
}
