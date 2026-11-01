import type { TailWatch } from "@keepdeck/plugin-api";

/**
 * The one watch on a rollout's `turn_context` — the record codex writes at
 * the start of every turn with the settings that turn runs under.
 *
 * ONE watch, because the host takes the first watch that matches a record
 * in a lane: a second watch on the same record type would never see one. So
 * every reader of a `turn_context` names its fields here:
 * - the collaboration mode, which says whether a question blocks (questions.ts);
 * - the approval policy and the sandbox — `sandbox_policy`, and the newer
 *   `permission_profile` — which say how freely the turn acts (mode.ts).
 *
 * Context replay: catching up on a store's old turns seeds what a later
 * record is read against, and publishes nothing — an older process's mode is
 * never this one's.
 */
export const turnContextWatch: TailWatch = {
  match: [{ key: "type", equals: "turn_context" }],
  keep: [
    "type",
    "timestamp",
    "payload.collaboration_mode.mode",
    "payload.approval_policy",
    "payload.sandbox_policy.type",
    "payload.permission_profile.type",
  ],
  lane: "status",
  replayContext: true,
};
