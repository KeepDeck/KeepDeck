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

import { asNonEmptyString } from "./usage.ts";

/** Why an agent is waiting on the user. `permission` = a tool-approval
 * prompt is up; `question` = the agent itself asked for input. */
export type StatusWaitReason = "permission" | "question";

/** One turn-lifecycle edge, as a normalizer reports it. `at` is unix
 * milliseconds — the host's receipt time for hook edges (reporters are
 * shell scripts with no clock discipline), OVERRIDDEN with the marker's
 * own source time for tail-recovered markers via [`statusSourceInstant`]:
 * a marker trails its turn by up to a poll interval, and only its honest
 * age lets the reducer drop one that predates the turn it would end. */
export type AgentStatusEvent =
  /** The user submitted a prompt — the turn is running. */
  | { kind: "turn-start"; at: number }
  /** The turn is parked on the user (approval dialog, agent question). */
  | { kind: "waiting"; at: number; reason: StatusWaitReason }
  /** The wait resolved and the turn is running again. Only CLIs with a
   * resolution event emit this; for the rest the next edge settles it. */
  | { kind: "resumed"; at: number }
  /** The CLI closed its turn, but work that turn STARTED is still running
   * and will wake the session again when it finishes (claude's background
   * agents and shell tasks). Emitted INSTEAD of `turn-end`, never beside
   * it: the turn is parked, not over, and only the CLI's next real ending
   * closes it. Deliberately not `resumed` — parking resolves nothing, and
   * a wait already on screen may belong to the very work still running. */
  | { kind: "parked"; at: number }
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
 * HOST-owned payload keys, not agent schema: `agent` (the dispatch key);
 * and on the transcript tailer's recovered markers `kind`
 * ("session.interrupt"), `reason` (the CLI's abort reason — only
 * "interrupted" is the user's hand), `sourceAt`/`sourceMtimeMs` (the
 * marker's own time — see [`statusSourceInstant`]). A hook reporter's
 * payload instead rides verbatim under `event`. An agent whose interrupts
 * the tailer recovers (claude, codex) must map the marker; the rest never
 * receive one. */
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

/** A `turn-failed` edge from a CLI's raw failure fields — the shared shape
 * of every StopFailure-style hook (claude `error`/`error_details`, kimi
 * `error_type`/`error_message`): a non-empty error or the honest
 * "unknown", and the prose only when the CLI sent any (never a
 * `detail: undefined` key). */
export function turnFailedEvent(
  at: number,
  error: unknown,
  detail: unknown,
): AgentStatusEvent {
  const prose = asNonEmptyString(detail);
  return {
    kind: "turn-failed",
    at,
    error: asNonEmptyString(error) ?? "unknown",
    ...(prose !== undefined ? { detail: prose } : {}),
  };
}
