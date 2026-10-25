import type { AgentStatusEvent, NormalizedUsage } from "@keepdeck/plugin-api";
import { maybeRecord } from "@keepdeck/plugin-api/testing";

/**
 * The shared value/DOM guards live in the contract's own test entry point, so
 * core, packages and plugins prove their fixtures one way. This module adds
 * only the app-side payload readers.
 */
export {
  booleanOf,
  elementOf,
  elementsOf,
  instanceOf,
  listOf,
  maybeRecord,
  numberOf,
  recordOf,
  recordsOf,
  sessionIds,
  stringOf,
} from "@keepdeck/plugin-api/testing";

function isNormalizedUsage(value: unknown): value is NormalizedUsage {
  const record = maybeRecord(value);
  return (
    record !== undefined &&
    (record.account === null || typeof record.account === "object") &&
    (record.pane === null || typeof record.pane === "object")
  );
}

/** The normalized usage a probe's normalizer was handed, or `null` when the
 * payload is not the echo shape the test reports. */
export function usageResult(payload: unknown): NormalizedUsage | null {
  const result = maybeRecord(payload)?.result;
  return isNormalizedUsage(result) ? result : null;
}

function isAgentStatusEvent(value: unknown): value is AgentStatusEvent {
  const record = maybeRecord(value);
  return record !== undefined && typeof record.kind === "string" && typeof record.at === "number";
}

/** The status edge a probe's handler was handed, or `null` when absent. */
export function statusEdge(payload: unknown): AgentStatusEvent | null {
  const edge = maybeRecord(payload)?.edge;
  return isAgentStatusEvent(edge) ? edge : null;
}
