import type { UnconnectedLaunch } from "../domain/agents";

/** What a pane whose agent the deck cannot hear says about it — the
 * header's dot and the bell's entry both read these words (task-572).
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
  switch (launch.cause) {
    case "plan-failed":
    case "command-refused": {
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
    // Its tools and skills still work: what is lost is the deck hearing it.
    case "bridge-down":
      return {
        label: "KeepDeck can't hear this agent",
        sentence: "KeepDeck can't hear this agent",
        reason: "KeepDeck's bridge to its agents did not start, so this agent's status, conversation and mail asks never reach it. Status, mail and resume won't work until KeepDeck restarts.",
      };
    case "pane-dir-failed":
      return {
        label: "KeepDeck can't hear this agent",
        sentence: "KeepDeck can't hear this agent",
        reason: `KeepDeck could not make this agent's bridge folder: ${launch.error}. Status, mail and resume won't work until the agent restarts.`,
      };
  }
}
