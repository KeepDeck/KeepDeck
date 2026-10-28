import type {
  AgentIcon,
  AgentIconPath,
  AgentLiveSession,
  AgentSessionFacts,
  AgentSessionStub,
  AgentTranscriptEntry,
  Shortfall,
  SpawnArmOutput,
} from "@keepdeck/plugin-api";
import type {
  WireAgentHistoryCall,
  WireSpawnPlanOutput,
} from "./protocol";
import { isObjectLike, isWireArmOutput } from "./decode";

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
  if (isObjectLike(value)) {
    const v = value;
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
  if (!isObjectLike(value)) return undefined;
  const v = value;
  if (typeof v.viewBox !== "string" || !Array.isArray(v.paths))
    return undefined;
  const paths = v.paths.flatMap((layer): AgentIconPath[] => {
    if (!isObjectLike(layer)) return [];
    const l = layer;
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
/** `arm.plan`'s answer, rebuilt from its strings alone — the realm's word
 * plants files in a user's directory, so nothing else rides along. */
export function sanitizeArmOutput(value: unknown): SpawnArmOutput | null {
  if (!isWireArmOutput(value)) return null;
  return {
    cwd: value.cwd.map((arm) =>
      arm.kind === "file"
        ? { kind: "file", path: arm.path, content: arm.content }
        : { kind: "symlink", path: arm.path, target: arm.target },
    ),
  };
}

export function sanitizePlanOutput(value: unknown): WireSpawnPlanOutput | null {
  if (!isObjectLike(value)) return null;
  const v = value;
  if (v.command !== null && typeof v.command !== "string") return null;
  const args = v.args;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string"))
    return null;
  const env = v.env;
  if (
    !Array.isArray(env) ||
    !env.every(
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
  const envDefaults = v.envDefaults;
  if (envDefaults !== undefined && !pairs(envDefaults)) return null;
  const strings = (val: unknown): val is string[] =>
    Array.isArray(val) && val.every((x) => typeof x === "string");
  const rawDiscard = v.discard;
  if (rawDiscard !== undefined && !isObjectLike(rawDiscard)) return null;
  const discard = rawDiscard;
  const onceStarted = discard?.onceStarted;
  const ifNeverStarted = discard?.ifNeverStarted;
  if (onceStarted !== undefined && !strings(onceStarted)) return null;
  if (ifNeverStarted !== undefined && !strings(ifNeverStarted)) return null;
  const command = v.command;
  const envDefaultsOk = envDefaults === undefined ? undefined : envDefaults;
  return {
    command,
    args,
    env,
    ...(envDefaultsOk !== undefined ? { envDefaults: envDefaultsOk } : {}),
    ...(discard !== undefined && {
      discard: {
        ...(onceStarted !== undefined && { onceStarted }),
        ...(ifNeverStarted !== undefined && { ifNeverStarted }),
      },
    }),
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
    if (!isObjectLike(item)) return null;
    const v = item;
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
  if (!isObjectLike(value)) return null;
  const v = value;
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
    if (!isObjectLike(item)) return null;
    const v = item;
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

/** A finite, non-negative number and nothing else. A measure that arrived as
 * a string, a NaN or an Infinity is not a measure — and neither is a negative
 * one: nothing here can be short by less than nothing, so the boundary
 * refuses the impossible rather than passing it to a reader who would have to
 * puzzle over it. */
function measure(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A realm's shortfall — every element rebuilt from its own kind's fields.
 *
 * The discriminant is matched LITERALLY: an unknown kind fails the whole
 * answer rather than passing through as an unreadable shape, because a
 * measure nobody can interpret is worse than none. An EMPTY array fails too
 * — absence already spells "nothing was missed", and a second spelling of
 * one truth invites the two to drift apart. */
function sanitizeShortfall(value: unknown): Shortfall[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const result: Shortfall[] = [];
  for (const item of value) {
    if (!isObjectLike(item)) return null;
    const v = item;
    switch (v.kind) {
      case "bytes":
        if (!measure(v.size) || !measure(v.readBytes)) return null;
        result.push({ kind: "bytes", size: v.size, readBytes: v.readBytes });
        break;
      case "turns":
        if (!measure(v.total) || !measure(v.returned)) return null;
        result.push({ kind: "turns", total: v.total, returned: v.returned });
        break;
      case "parts":
        if (!measure(v.unreadableParts)) return null;
        result.push({ kind: "parts", unreadableParts: v.unreadableParts });
        break;
      default:
        return null;
    }
  }
  return result;
}

export function sanitizeHistoryFacts(value: unknown): AgentSessionFacts | null {
  if (!isObjectLike(value)) return null;
  const v = value;
  if (
    typeof v.cwd !== "string" ||
    (v.title !== undefined && typeof v.title !== "string") ||
    (v.transcriptPath !== undefined && typeof v.transcriptPath !== "string")
  )
    return null;
  // Present-but-malformed fails the answer; absent stays absent. The
  // boundary rebuilds from known fields, so a shortfall left OUT of this
  // list would be dropped in silence — the very silence the field exists
  // to end.
  const shortfall =
    v.shortfall === undefined ? undefined : sanitizeShortfall(v.shortfall);
  if (shortfall === null) return null;
  return {
    cwd: v.cwd,
    ...(typeof v.title === "string" ? { title: v.title } : {}),
    ...(typeof v.transcriptPath === "string"
      ? { transcriptPath: v.transcriptPath }
      : {}),
    ...(shortfall !== undefined ? { shortfall } : {}),
  };
}

/** A realm's `transcriptPage()` answer — the transcript sanitizer's entries
 * plus the reading's own shortfall. No `complete` flag crosses: completeness
 * is derived from the shortfall's absence, and a duplicate of a derived
 * truth invites the two to disagree. */
export function sanitizeHistoryTranscriptPage(
  value: unknown,
): { entries: AgentTranscriptEntry[]; shortfall?: Shortfall[] } | null {
  if (!isObjectLike(value)) return null;
  const v = value;
  const entries = sanitizeHistoryTranscript(v.entries);
  if (entries === null) return null;
  const shortfall =
    v.shortfall === undefined ? undefined : sanitizeShortfall(v.shortfall);
  if (shortfall === null) return null;
  return { entries, ...(shortfall !== undefined ? { shortfall } : {}) };
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
    if (!isObjectLike(item)) return null;
    const v = item;
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
