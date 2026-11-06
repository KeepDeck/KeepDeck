import type { UnconnectedLaunch } from "../domain/agents";

/** What a pane whose agent runs without KeepDeck's setup says about it —
 * the header's dot and the bell's entry both read these words (task-572).
 * The state is named by what a person sees (no status, no mail, no resume),
 * not by the mechanism that caused it. */
export interface UnconnectedLaunchView {
  /** The state, capitalized — the dot's label. */
  label: string;
  /** The same fact as prose, for a notification title. */
  sentence: string;
  /** Why, and what it costs. */
  reason: string;
}

export function unconnectedLaunchView(launch: UnconnectedLaunch): UnconnectedLaunchView {
  const why =
    launch.cause === "plan-failed"
      ? launch.error
      : `${launch.pluginId} asked to run "${launch.command}", which it is not allowed to run`;
  return {
    label: "Not connected to KeepDeck",
    sentence: "not connected to KeepDeck",
    reason: `KeepDeck could not set this agent up: ${why}. Status, mail and resume won't work until the agent restarts.`,
  };
}
