import type { PaneActivity } from "./activity";

/** The tone a surface renders an activity in — a closed set so the CSS
 * ladder is exhaustive and a new state is a compile error at the view. */
export type ActivityTone = "working" | "waiting" | "done" | "failed";

/** Everything a view shows for one activity — settled here so the view
 * renders and nothing else ([`rule/no-logic-in-views`]). `at` is the
 * instant the badge ages from ("12m"); formatting stays in the view. */
export interface ActivityBadge {
  tone: ActivityTone;
  label: string;
  /** Tooltip prose beyond the label, when the state carries any. */
  detail?: string;
  at: number;
}

/** The typed API-error reasons claude names; other CLIs send their own
 * strings and fall through to the raw value. */
const FAILURE_LABELS: Record<string, string> = {
  rate_limit: "Rate limited",
  overloaded: "Provider overloaded",
  authentication_failed: "Authentication failed",
  oauth_org_not_allowed: "Organization not allowed",
  billing_error: "Billing error",
  invalid_request: "Invalid request",
  model_not_found: "Model not found",
  server_error: "Provider error",
  max_output_tokens: "Output limit hit",
  unknown: "Turn failed",
};

/** One badge per activity. Pure — the view calls it and renders. */
export function activityBadge(activity: PaneActivity): ActivityBadge {
  switch (activity.state) {
    case "working":
      return { tone: "working", label: "Working", at: activity.since };
    case "waiting":
      return {
        tone: "waiting",
        label:
          activity.reason === "permission"
            ? "Needs approval"
            : "Needs your input",
        at: activity.since,
      };
    case "done":
      return activity.interrupted
        ? { tone: "done", label: "Interrupted", at: activity.at }
        : { tone: "done", label: "Done", at: activity.at };
    case "failed":
      return {
        tone: "failed",
        label: FAILURE_LABELS[activity.error] ?? `Failed: ${activity.error}`,
        ...(activity.detail !== undefined ? { detail: activity.detail } : {}),
        at: activity.at,
      };
  }
}
