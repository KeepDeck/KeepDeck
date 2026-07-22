import {
  asFiniteNumber,
  asNonEmptyString,
  clampPercent,
  collectTokenCounts,
  isJsonRecord,
  type AccountUsage,
  type LimitsNormalizer,
  type PaneUsage,
  type TokenCounts,
  type UsageNormalizer,
  type UsageWindow,
} from "@keepdeck/plugin-api";

/**
 * Codex usage normalizer — this plugin owns the rollout-event schema the
 * host's tailer forwards: `{agent:"codex", event}` where event is a
 * `token_count` (windows + tokens) or a `turn_context` (model). The store
 * merges the two — neither may erase the other.
 */

/** One rate_limits window ({used_percent, window_minutes, resets_at
 * seconds}) → normalized, or null when the shape is off. */
function window(value: unknown): UsageWindow | null {
  if (!isJsonRecord(value)) return null;
  const usedPct = asFiniteNumber(value.used_percent);
  if (usedPct === undefined) return null;
  const resetsAt = asFiniteNumber(value.resets_at);
  return {
    usedPct: clampPercent(usedPct),
    resetsAt: resetsAt !== undefined ? resetsAt * 1000 : null,
    windowMinutes: asFiniteNumber(value.window_minutes) ?? null,
  };
}

/** One app-server rate-limit window. Generated schemas call the duration
 * `windowDurationMins`; an older documented shape used `windowMinutes`, so
 * tolerate both while keeping the official camelCase wire otherwise. */
function appServerWindow(value: unknown): UsageWindow | null {
  if (!isJsonRecord(value)) return null;
  const usedPct = asFiniteNumber(value.usedPercent);
  if (usedPct === undefined) return null;
  const resetsAt = asFiniteNumber(value.resetsAt);
  return {
    usedPct: clampPercent(usedPct),
    resetsAt: resetsAt !== undefined ? resetsAt * 1000 : null,
    windowMinutes:
      asFiniteNumber(value.windowDurationMins) ??
      asFiniteNumber(value.windowMinutes) ??
      null,
  };
}

/** The backward-compatible snapshot is normally `rateLimits`. If a Codex
 * version only returns the newer multi-bucket map, prefer its `codex`
 * bucket and then the first recognizable bucket. */
function appServerSnapshot(response: Record<string, unknown>): unknown {
  if (isJsonRecord(response.rateLimits)) return response.rateLimits;
  if (!isJsonRecord(response.rateLimitsByLimitId)) return null;
  if (isJsonRecord(response.rateLimitsByLimitId.codex)) {
    return response.rateLimitsByLimitId.codex;
  }
  return Object.values(response.rateLimitsByLimitId).find(isJsonRecord) ?? null;
}

/** Official `account/rateLimits/read` response → the same account domain
 * shape rollout events already produce. The app-server schema is generated
 * per installed Codex version, so malformed/unsupported shapes are a quiet
 * null and the rollout/cache fallback keeps working. */
export const normalizeCodexRateLimits: LimitsNormalizer = (body, at) => {
  let response: unknown;
  try {
    response = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isJsonRecord(response)) return null;
  const snapshot = appServerSnapshot(response);
  if (!isJsonRecord(snapshot)) return null;
  const windows = [snapshot.primary, snapshot.secondary]
    .map(appServerWindow)
    .filter((candidate): candidate is UsageWindow => candidate !== null);
  if (windows.length === 0) return null;
  return {
    kind: "reported",
    windows,
    reportedAt: at,
    sourcePaneId: "",
  };
};

/** Codex token bags share one field naming across total/last. */
function tokens(value: unknown): TokenCounts | undefined {
  if (!isJsonRecord(value)) return undefined;
  return collectTokenCounts({
    input: value.input_tokens,
    output: value.output_tokens,
    cacheRead: value.cached_input_tokens,
    cacheWrite: undefined,
    reasoning: value.reasoning_output_tokens,
    total: value.total_tokens,
  });
}

// Codex excludes the fixed system prompt and tool instructions from the
// percentage shown in its status line. Keep this formula byte-for-byte in
// step with TokenUsage::percent_of_context_window_remaining in codex-cli:
// normalize both sides by the baseline, round remaining, then invert.
const CODEX_BASELINE_TOKENS = 12_000;

function contextUsedPct(inContext: number, contextWindow: number): number {
  if (contextWindow <= CODEX_BASELINE_TOKENS) return 100;

  const effectiveWindow = contextWindow - CODEX_BASELINE_TOKENS;
  const used = Math.max(0, inContext - CODEX_BASELINE_TOKENS);
  const remaining = Math.max(0, effectiveWindow - used);
  const remainingPct = Math.round(
    clampPercent((remaining / effectiveWindow) * 100),
  );
  return clampPercent(100 - remainingPct);
}

/**
 * Windows come from primary/secondary WITHOUT positional meaning: on some
 * plans primary IS the weekly window and secondary is null (verified live)
 * — labels derive from window_minutes downstream. No `unavailable` claim
 * here: a signed-out codex simply produces no rollout events.
 */
export const normalizeCodexRollout: UsageNormalizer = (payload, at) => {
  if (!isJsonRecord(payload)) return null;
  const event = payload.event;
  if (!isJsonRecord(event)) return null;

  if (event.type === "turn_context") {
    const model = asNonEmptyString(event.model);
    if (!model) return { account: null, pane: null };
    const effort = asNonEmptyString(event.effort);
    return {
      account: null,
      pane: {
        agent: "codex",
        model: effort ? `${model} ${effort}` : model,
        reportedAt: at,
      },
    };
  }
  if (event.type !== "token_count") return null;

  let account: AccountUsage | null = null;
  const limits = isJsonRecord(event.rate_limits) ? event.rate_limits : undefined;
  if (limits) {
    const windows = [limits.primary, limits.secondary]
      .map(window)
      .filter((w): w is UsageWindow => w !== null);
    if (windows.length > 0) {
      account = { kind: "reported", windows, reportedAt: at, sourcePaneId: "" };
    }
  }

  const info = isJsonRecord(event.info) ? event.info : undefined;
  const windowTokens = info ? asFiniteNumber(info.model_context_window) : undefined;
  const lastTurnTokens = info ? tokens(info.last_token_usage) : undefined;
  const totalTokens = info ? tokens(info.total_token_usage) : undefined;
  // last_token_usage.total_tokens is the raw occupancy. Codex's own UI
  // removes its fixed baseline before presenting the user-controlled share.
  const inContext = lastTurnTokens?.total;
  const pane: PaneUsage = {
    agent: "codex",
    ...(inContext !== undefined && windowTokens !== undefined && windowTokens > 0
      ? {
          context: {
            usedPct: contextUsedPct(inContext, windowTokens),
            windowTokens,
          },
        }
      : {}),
    ...(totalTokens ? { totalTokens } : {}),
    ...(lastTurnTokens ? { lastTurnTokens } : {}),
    reportedAt: at,
  };

  return { account, pane };
};
