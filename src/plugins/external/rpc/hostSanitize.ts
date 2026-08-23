import type {
  AgentIcon,
  AgentIconPath,
  AgentLiveSession,
  AgentSessionFacts,
  AgentSessionStub,
  AgentTranscriptEntry,
} from "@keepdeck/plugin-api";
import type {
  WireAgentHistoryCall,
  WireSpawnPlanOutput,
} from "./protocol";

/**
 * The boundary's rebuild rules. Nothing a realm says is passed through: every
 * reply is REBUILT here from the fields this side knows, so an unknown extra
 * field drops rather than travelling on, and an off-shape one fails the whole
 * answer instead of half-inventing it.
 *
 * They live apart from the dispatch table because they share none of its
 * state — no context, no registrations, no pending calls. A validator that
 * closes over nothing can be read, tested and reasoned about alone, which is
 * exactly what a trust boundary wants.
 */

/**
 * Shape a realm's reply BEFORE it may settle a pending host→realm call. The
 * settle callbacks run after `clearTimeout` — a `result.ok` read throwing on
 * junk (`[id]` with no result, `null`, a primitive) would strand the pending
 * promise FOREVER, past the very timeout built to prevent hangs. So junk
 * becomes an explicit failure, and only a literal `ok: true` reaches `onOk`.
 */
export function asRealmResult<T extends { ok: true }>(
  value: unknown,
  onOk: (v: Record<string, unknown>) => T,
): T | { ok: false; error: string } {
  if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    if (v.ok === true) return onOk(v);
    if (v.ok === false) {
      return {
        ok: false,
        error: typeof v.error === "string" ? v.error : "realm reported a failure",
      };
    }
  }
  return { ok: false, error: "malformed result from the realm" };
}

/** Accept a realm-supplied agent icon only in the contract's exact shape —
 * plain strings bound for SVG attributes; an off-shape layer drops, and an
 * icon with nothing left drops to `undefined` (no icon) rather than refusing
 * the registration. */
export function sanitizeAgentIcon(value: unknown): AgentIcon | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.viewBox !== "string" || !Array.isArray(v.paths))
    return undefined;
  const paths = v.paths.flatMap((layer): AgentIconPath[] => {
    if (typeof layer !== "object" || layer === null) return [];
    const l = layer as Record<string, unknown>;
    if (typeof l.d !== "string") return [];
    return [
      {
        d: l.d,
        ...(typeof l.color === "string" ? { color: l.color } : {}),
        ...(l.fillRule === "evenodd" ? { fillRule: l.fillRule } : {}),
      },
    ];
  });
  if (paths.length === 0) return undefined;
  return { viewBox: v.viewBox, paths };
}

/** Validate a realm-returned plan output down to plain strings; `null` when
 * anything is off-shape. */
export function sanitizePlanOutput(value: unknown): WireSpawnPlanOutput | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.command !== null && typeof v.command !== "string") return null;
  if (!Array.isArray(v.args) || !v.args.every((a) => typeof a === "string"))
    return null;
  if (
    !Array.isArray(v.env) ||
    !v.env.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((x) => typeof x === "string"),
    )
  )
    return null;
  const pairs = (val: unknown): val is [string, string][] =>
    Array.isArray(val) &&
    val.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((x) => typeof x === "string"),
    );
  if (v.envDefaults !== undefined && !pairs(v.envDefaults)) return null;
  return {
    command: v.command as string | null,
    args: v.args as string[],
    env: v.env as [string, string][],
    ...(v.envDefaults !== undefined
      ? { envDefaults: v.envDefaults as [string, string][] }
      : {}),
  };
}

export function requireHistoryResult<T>(
  method: WireAgentHistoryCall["method"],
  value: unknown,
  sanitize: (value: unknown) => T | null,
): T {
  const result = sanitize(value);
  if (result === null)
    throw new Error(`agent history ${method} returned malformed data`);
  return result;
}

export function sanitizeHistoryList(value: unknown): AgentSessionStub[] | null {
  if (!Array.isArray(value)) return null;
  const result: AgentSessionStub[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const v = item as Record<string, unknown>;
    if (
      typeof v.sessionId !== "string" ||
      typeof v.ref !== "string" ||
      typeof v.mtime !== "number" ||
      !Number.isFinite(v.mtime) ||
      typeof v.size !== "number" ||
      !Number.isFinite(v.size)
    )
      return null;
    result.push({
      sessionId: v.sessionId,
      ref: v.ref,
      mtime: v.mtime,
      size: v.size,
    });
  }
  return result;
}

/** A realm's `listing()` answer — the list sanitizer's shape plus the
 * integrity flag, which must be a LITERAL boolean: a hostile realm's
 * "complete": "yes" must fail the boundary, not read as a prune permit. */
export function sanitizeHistoryListing(
  value: unknown,
): { stubs: AgentSessionStub[]; complete: boolean } | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.complete !== "boolean") return null;
  const stubs = sanitizeHistoryList(v.stubs);
  if (stubs === null) return null;
  return { stubs, complete: v.complete };
}

/** A realm's live-sessions answer — rebuilt from known fields only, like
 * every other reply that crosses this boundary. Junk rows fail the WHOLE
 * answer (never a half-invented registry), and the optional strings drop
 * rather than pass through: a hostile realm's word about live processes
 * only ever gets to be plain data. */
export function sanitizeLiveSessions(value: unknown): AgentLiveSession[] | null {
  if (!Array.isArray(value)) return null;
  const result: AgentLiveSession[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const v = item as Record<string, unknown>;
    if (typeof v.sessionId !== "string" || typeof v.kind !== "string")
      return null;
    result.push({
      sessionId: v.sessionId,
      kind: v.kind,
      ...(typeof v.name === "string" ? { name: v.name } : {}),
      ...(typeof v.state === "string" ? { state: v.state } : {}),
    });
  }
  return result;
}

export function requireLiveResult<T>(
  value: unknown,
  sanitize: (value: unknown) => T | null,
): T {
  const result = sanitize(value);
  if (result === null)
    throw new Error("agent live-sessions returned malformed data");
  return result;
}

export function sanitizeHistoryFacts(value: unknown): AgentSessionFacts | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.cwd !== "string" ||
    (v.title !== undefined && typeof v.title !== "string") ||
    (v.transcriptPath !== undefined && typeof v.transcriptPath !== "string")
  )
    return null;
  return {
    cwd: v.cwd,
    ...(typeof v.title === "string" ? { title: v.title } : {}),
    ...(typeof v.transcriptPath === "string"
      ? { transcriptPath: v.transcriptPath }
      : {}),
  };
}

export function sanitizeHistoryContent(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function sanitizeHistoryTranscript(
  value: unknown,
): AgentTranscriptEntry[] | null {
  if (!Array.isArray(value)) return null;
  const result: AgentTranscriptEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const v = item as Record<string, unknown>;
    if (
      (v.role !== "user" &&
        v.role !== "assistant" &&
        v.role !== "other") ||
      typeof v.text !== "string"
    )
      return null;
    result.push({ role: v.role, text: v.text });
  }
  return result;
}
