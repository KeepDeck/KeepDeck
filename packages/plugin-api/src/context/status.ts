/**
 * Status contract — how a CLI plugin teaches KeepDeck to read its agent's
 * turn lifecycle: a turn starting, waiting on the user, ending, failing.
 * The plugin owns its CLI's payload SCHEMA (the normalizer below); the host
 * owns the transport (bridge envelopes, the native transcript tailer's
 * interrupt markers) and the store/UI.
 *
 * The wire carries EDGES, not states: a normalizer reports what just
 * happened, and the host's pure reducer folds edges into the pane's current
 * activity. An edge stream can express re-assertions and out-of-band
 * recoveries (a transcript interrupt marker) that a precomputed state
 * enum cannot.
 */

/** Why an agent is waiting on the user. `permission` = a tool-approval
 * prompt is up; `question` = the agent itself asked for input. */
export type StatusWaitReason = "permission" | "question";

/** One turn-lifecycle edge, as a normalizer reports it. `at` is unix
 * milliseconds — injected by the host at receipt, never read from the
 * payload (reporters are shell scripts with no clock discipline). */
export type AgentStatusEvent =
  /** The user submitted a prompt — the turn is running. */
  | { kind: "turn-start"; at: number }
  /** The turn is parked on the user (approval dialog, agent question). */
  | { kind: "waiting"; at: number; reason: StatusWaitReason }
  /** The wait resolved and the turn is running again. Only CLIs with a
   * resolution event emit this; for the rest the next edge settles it. */
  | { kind: "resumed"; at: number }
  /** The turn completed normally. */
  | { kind: "turn-end"; at: number }
  /** The user interrupted the turn (Esc/Ctrl-C) — it is over, but not
   * "done" in the completed sense. */
  | { kind: "interrupted"; at: number }
  /** The turn died on an API error. `error` is the CLI's error type
   * (e.g. `rate_limit`, `authentication_failed`); `detail` its prose. */
  | { kind: "turn-failed"; at: number; error: string; detail?: string };

/** A per-agent normalizer: raw bridge status payload → one edge, or null
 * when the payload is not a tracked event. Pure; time is injected.
 *
 * One payload key is HOST-owned transport metadata, not agent schema:
 * `agent` (the dispatch key). The CLI's own event rides under `event`,
 * verbatim as the reporter captured it. */
export type StatusNormalizer = (
  payload: unknown,
  at: number,
) => AgentStatusEvent | null;

/** The status half of an agent contribution.
 *
 * BUILT-IN (in-process) agents only for now, like `AgentUsage`: the store
 * invokes `normalize` synchronously per report, and a cross-realm proxy is
 * necessarily async. An external plugin's declaration is ignored with a
 * host-log warning. */
export interface AgentStatus {
  /** Normalize this agent's bridge status payloads (hook reporters, the
   * host tailer's interrupt markers — whatever its reporters emit). */
  normalize: StatusNormalizer;
}

/* ---- Authoring helpers ----------------------------------------------- */

/** The instant a host-relayed payload names (`sourceAt` as an ISO string or
 * unix milliseconds, `sourceMtimeMs` as the file-mtime fallback), or
 * `fallback` when it names none. The transcript tailer's markers arrive up
 * to a poll interval late — their HONEST time is the marker's own, and an
 * edge stamped with it lets the host drop a marker that predates the turn
 * it would end. */
export function statusSourceInstant(
  payload: Record<string, unknown>,
  fallback: number,
): number {
  for (const key of ["sourceAt", "sourceMtimeMs"] as const) {
    const value = payload[key];
    const instant =
      typeof value === "string" ? Date.parse(value) : (value as unknown);
    if (typeof instant === "number" && Number.isFinite(instant) && instant > 0) {
      return instant;
    }
  }
  return fallback;
}
