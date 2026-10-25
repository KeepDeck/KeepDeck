import type { AgentStatusEvent, NormalizedUsage } from "@keepdeck/plugin-api";

/** A record a test is about to read fields from, or a failure naming what was
 * expected. The guard is the only thing that makes the value a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`expected ${what}, found ${typeof value}`);
  return value;
}

/** An array a test is about to map, or a failure naming what was expected. */
export function listOf(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${what}, found ${typeof value}`);
  }
  return [...value];
}

/** A list of records a test is about to read fields from. */
export function recordsOf(value: unknown, what: string): Record<string, unknown>[] {
  return listOf(value, what).map((item) => recordOf(item, what));
}

/** The `sessionId` of each record in a list. */
export function sessionIds(value: unknown, what = "session records"): string[] {
  return recordsOf(value, what).map((record) =>
    stringOf(record.sessionId, "session id"),
  );
}

export function booleanOf(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new Error(`expected ${what} to be a boolean`);
  return value;
}

export function stringOf(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`expected ${what} to be a string`);
  return value;
}

export function numberOf(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`expected ${what} to be a finite number`);
  }
  return value;
}

/** The element matched by `selector` in `root`, proven to be a `ctor`. */
export function elementOf<T extends Element>(
  root: ParentNode,
  selector: string,
  ctor: abstract new (...args: never[]) => T,
): T {
  const found = root.querySelector(selector);
  if (!(found instanceof ctor)) {
    throw new Error(`expected ${selector} to be a ${ctor.name}`);
  }
  return found;
}

/** Every element matched by `selector` in `root`, each proven to be a `ctor`. */
export function elementsOf<T extends Element>(
  root: ParentNode,
  selector: string,
  ctor: abstract new (...args: never[]) => T,
): T[] {
  return [...root.querySelectorAll(selector)].map((found) =>
    instanceOf(found, ctor, selector),
  );
}

/** `value` proven to be a `ctor`, for a node a test already found. */
export function instanceOf<T>(
  value: unknown,
  ctor: abstract new (...args: never[]) => T,
  what: string,
): T {
  if (!(value instanceof ctor)) throw new Error(`expected ${what} to be a ${ctor.name}`);
  return value;
}

function isNormalizedUsage(value: unknown): value is NormalizedUsage {
  if (!isRecord(value)) return false;
  const record = value;
  return (
    (record.account === null || typeof record.account === "object") &&
    (record.pane === null || typeof record.pane === "object")
  );
}

/** The normalized usage a probe's normalizer was handed, or `null` when the
 * payload is not the echo shape the test reports. */
export function usageResult(payload: unknown): NormalizedUsage | null {
  if (!isRecord(payload)) return null;
  return isNormalizedUsage(payload.result) ? payload.result : null;
}

function isAgentStatusEvent(value: unknown): value is AgentStatusEvent {
  if (!isRecord(value)) return false;
  return typeof value.kind === "string" && typeof value.at === "number";
}

/** The status edge a probe's handler was handed, or `null` when absent. */
export function statusEdge(payload: unknown): AgentStatusEvent | null {
  if (!isRecord(payload) || !isAgentStatusEvent(payload.edge)) return null;
  return payload.edge;
}
