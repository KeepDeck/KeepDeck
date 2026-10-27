import type { PaneActivity } from "../domain/status";

/** The tone a surface renders an activity in — a closed set so the CSS
 * ladder is exhaustive and a new state is a compile error at the view. */
export type ActivityTone = "working" | "waiting" | "done" | "failed";

/** Everything a view shows for one activity — settled here so the view
 * renders and nothing else ([`rule/no-logic-in-views`]). */
export interface ActivityBadge {
  tone: ActivityTone;
  /** Header/tooltip text, capitalized. */
  label: string;
  /** The same fact as prose for a notification body ("Claude 1 — needs
   * approval"): casing settled HERE, because lowercasing the label would
   * mangle a CLI's own error identifier ("failed: quotacliff"). */
  sentence: string;
  /** Tooltip prose beyond the label, when the state carries any. */
  detail?: string;
  /** The instant the badge ages from — "· 12m ago" in the tooltip. */
  at: number;
}

/** The failure codes every agent's normalizer may report in the shared
 * vocabulary — the host words these. A code of one CLI's own is worded by
 * that agent's plugin (`presentation.failureLabels`), or shown raw. */
const SHARED_FAILURE_LABELS: Readonly<Record<string, string>> = {
  rate_limit: "Rate limited",
  overloaded: "Provider overloaded",
  authentication_failed: "Authentication failed",
  unknown: "Turn failed",
};

/** One badge per activity. Pure — the view calls it and renders.
 * `failureLabels` are the pane's agent's own words for its failure codes. */
export function activityBadge(
  activity: PaneActivity,
  failureLabels: Readonly<Record<string, string>> | undefined,
): ActivityBadge {
  switch (activity.state) {
    case "working":
      return {
        tone: "working",
        label: "Working",
        sentence: "working",
        at: activity.since,
      };
    case "waiting": {
      const label =
        activity.reason === "permission" ? "Needs approval" : "Needs your input";
      return {
        tone: "waiting",
        label,
        sentence: label.toLowerCase(),
        at: activity.since,
      };
    }
    case "done":
      return activity.interrupted
        ? {
            tone: "done",
            label: "Interrupted",
            sentence: "interrupted",
            at: activity.at,
          }
        : {
            tone: "done",
            label: "Done",
            sentence: "finished",
            at: activity.at,
          };
    case "failed": {
      const known = SHARED_FAILURE_LABELS[activity.error] ?? failureLabels?.[activity.error];
      return {
        tone: "failed",
        label: known ?? `Failed: ${activity.error}`,
        // A known label lowercases safely (it is our own prose); a raw CLI
        // identifier keeps its casing.
        sentence: known ? known.toLowerCase() : `failed: ${activity.error}`,
        ...(activity.detail !== undefined ? { detail: activity.detail } : {}),
        at: activity.at,
      };
    }
  }
}
