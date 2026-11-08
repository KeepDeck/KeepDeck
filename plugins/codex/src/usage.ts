import {
  allowanceWindow,
  asCount,
  asFiniteNumber,
  asNonEmptyString,
  carriedRecord,
  clampPercent,
  isJsonRecord,
  parseJsonRecord,
  percentWindow,
  reportedLimits,
  type AccountUsage,
  type CallTokens,
  type CarriedRecord,
  type LimitsNormalizer,
  type LimitsRead,
  type PaneUsage,
  type PluginRpc,
  type TailWatch,
  type UsageCall,
  type UsageNormalizer,
  type UsageWindow,
} from "@keepdeck/plugin-api";

/**
 * Codex usage normalizer — this plugin owns the rollout-record schema, both
 * halves of it: which records carry the numbers (declared below) and what
 * they mean. A `token_count` brings the account's windows and the pane's
 * context; a `token_usage_record` is one call, run on the model the latest
 * `turn_context` names.
 */

/**
 * Which rollout records carry the numbers.
 *
 * The calls are codex 0.166's `token_usage_record`s: one per response, with
 * the response's own id — the id that makes a call count once. The running
 * `token_count` totals are NOT read for spend: a fork copies its source's
 * `token_count` events into the new rollout (while it drops every
 * `token_usage_record`), and a context-window overflow resets them.
 *
 * `turn_context` is the calls' context: the host attaches its model to every
 * call after it. `collab_agent_spawn_end` names a subagent thread — a
 * rollout of its own, found by [`UsageTail.locate`] and read with this one.
 *
 * Every event class is matched one level down, on `payload.type`: its class
 * (`event_msg`) also carries the assistant's own text — and a spawn record
 * its prompt — so only the named fields travel.
 */
export const codexUsageWatches: readonly TailWatch[] = [
  {
    match: [{ key: "type", equals: "turn_context" }],
    keep: ["payload.model"],
    lane: "calls",
    context: true,
  },
  {
    match: [
      { key: "type", equals: "token_usage_record" },
      { key: "payload.response_id" },
    ],
    keep: ["type", "payload.response_id", "payload.usage"],
    lane: "calls",
  },
  {
    match: [
      { key: "type", equals: "event_msg" },
      { key: "payload.type", equals: "collab_agent_spawn_end" },
      { key: "payload.new_thread_id" },
    ],
    keep: ["type", "payload.new_thread_id"],
    lane: "calls",
    links: true,
  },
  {
    match: [
      { key: "type", equals: "event_msg" },
      { key: "payload.type", equals: "token_count" },
    ],
    keep: ["payload"],
    lane: "usage",
  },
];

/** One rate_limits window ({used_percent, window_minutes, resets_at
 * seconds}) → normalized, or null when the shape is off. */
function window(value: unknown): UsageWindow | null {
  if (!isJsonRecord(value)) return null;
  return percentWindow({
    usedPct: value.used_percent,
    resetsAtSeconds: value.resets_at,
    windowMinutes: asFiniteNumber(value.window_minutes) ?? null,
  });
}

/** One app-server rate-limit window. Generated schemas call the duration
 * `windowDurationMins`; an older documented shape used `windowMinutes`, so
 * tolerate both while keeping the official camelCase wire otherwise. */
function appServerWindow(value: unknown): UsageWindow | null {
  if (!isJsonRecord(value)) return null;
  return percentWindow({
    usedPct: value.usedPercent,
    resetsAtSeconds: value.resetsAt,
    windowMinutes:
      asFiniteNumber(value.windowDurationMins) ??
      asFiniteNumber(value.windowMinutes) ??
      null,
  });
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

/**
 * The plan's absolute credit allowance, for accounts whose quota lives
 * nowhere else. `primary`/`secondary` are the rolling 5h/weekly windows
 * only Plus/Pro plans get; a business/Enterprise account reports both as
 * null and carries a monthly allowance in `individualLimit` instead —
 * `{limit:"16000", used:"5532.9…", remainingPercent:65, resetsAt:<secs>}`,
 * measured live. Reading only the two positions left that whole class of
 * accounts on "waiting for the first report" forever: this poll is their
 * SOLE source (the on-disk rollout events carry nulls too), so nothing
 * downstream could ever recover.
 *
 * The counts (shared math, strings and all) beat the integer-rounded
 * `remainingPercent`, which stays as the fallback for a shape carrying
 * only the percentage. `windowMinutes` stays null — nothing in the payload
 * states the duration, and inventing "month" would be the same
 * position-guessing this fixes; the domain labels a duration-less window
 * "plan". No scope, deliberately: this is the account's only limit, and a
 * scope would hide it from the chip.
 *
 * `credits` (prepaid balance) is left unread: no such account has been
 * observed, and a balance without a limit makes no percentage.
 */
function planAllowanceWindow(value: unknown): UsageWindow | null {
  if (!isJsonRecord(value)) return null;
  // A limit that is PRESENT but zero (or negative) is an account with no
  // usable quota — kimi's sibling reads the same shape as null, and a
  // percentage of nothing is not a reading. Only a limit that is genuinely
  // ABSENT may fall through to the percentage the provider computed itself.
  const limit = asCount(value.limit);
  if (limit !== undefined && limit <= 0) return null;
  const resetsSeconds = asCount(value.resetsAt);
  const resetsAt = resetsSeconds !== undefined ? resetsSeconds * 1000 : null;
  const window = allowanceWindow(value, { resetsAt, windowMinutes: null });
  if (window) return window;
  const remainingPct = asCount(value.remainingPercent);
  if (remainingPct === undefined) return null;
  return {
    usedPct: clampPercent(100 - remainingPct),
    resetsAt,
    windowMinutes: null,
  };
}

/** One read of the account's limits from codex's own app-server — the
 * server and method this plugin's manifest declares (`exec.servers`). The
 * host keeps the child and its handshake; codex reads its own credentials,
 * and KeepDeck never touches them. */
export async function readCodexLimits(rpc: PluginRpc): Promise<LimitsRead> {
  const answer = await rpc.request({ server: "app-server", method: "account/rateLimits/read" });
  return { body: answer.result, sourceAt: answer.sentAt };
}

/** Official `account/rateLimits/read` response → the same account domain
 * shape rollout events already produce. The app-server schema is generated
 * per installed Codex version, so malformed/unsupported shapes are a quiet
 * null and the rollout/cache fallback keeps working. */
export const normalizeCodexRateLimits: LimitsNormalizer = (body, at) => {
  const response = parseJsonRecord(body);
  if (!response) return null;
  const snapshot = appServerSnapshot(response);
  if (!isJsonRecord(snapshot)) return null;
  const windows = [snapshot.primary, snapshot.secondary]
    .map(appServerWindow)
    .filter((candidate): candidate is UsageWindow => candidate !== null);
  if (windows.length === 0) {
    // Rolling windows absent — the plan-allowance account. Only reached
    // when both positions yield nothing, so an allowance can never crowd a
    // Plus/Pro chip (the duration-less window would sort last there).
    const plan = planAllowanceWindow(snapshot.individualLimit);
    if (!plan) return null;
    return reportedLimits([plan], at);
  }
  return reportedLimits(windows, at);
};

/** A count, or 0 for anything that is not one. */
function count(value: unknown): number {
  const counted = asFiniteNumber(value);
  return counted !== undefined && counted > 0 ? counted : 0;
}

/**
 * One codex response's `usage` in the canonical classes.
 *
 * Codex counts its input the OpenAI way, WITH the cached prefix and the
 * cache writes in it: the fresh input is what remains of `input_tokens`
 * after both. Its output already holds the reasoning, which it states as a
 * share of it.
 */
function codexTokens(usage: Record<string, unknown>): CallTokens {
  const cacheRead = count(usage.cached_input_tokens);
  const cacheWrite = count(usage.cache_write_input_tokens);
  return {
    input: Math.max(0, count(usage.input_tokens) - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: count(usage.output_tokens),
    reasoning: count(usage.reasoning_output_tokens),
  };
}

/** One `token_usage_record` as its call — none without its id, its usage,
 * its time or the model the turn ran on. */
function codexCall(carried: CarriedRecord): UsageCall | null {
  const id = asNonEmptyString(carried.record["payload.response_id"]);
  const usage = carried.record["payload.usage"];
  const model = carried.context ? asNonEmptyString(carried.context["payload.model"]) : undefined;
  if (!id || !isJsonRecord(usage) || !model || carried.at === undefined) return null;
  return { id, at: carried.at, provider: "openai", model, tokens: codexTokens(usage) };
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
  const carried = carriedRecord(payload);
  if (!carried) return null;
  const { record } = carried;

  // A dotted `keep` arrives as a dotted KEY — what was asked for, under the
  // name it was asked for.
  if (record.type === "token_usage_record") {
    const call = codexCall(carried);
    return { account: null, pane: null, calls: call ? [call] : [] };
  }
  const spawned = asNonEmptyString(record["payload.new_thread_id"]);
  if (spawned) {
    return { account: null, pane: null, links: [spawned] };
  }
  const event = isJsonRecord(record.payload) ? record.payload : undefined;
  if (!event || event.type !== "token_count") return null;

  let account: AccountUsage | null = null;
  const limits = isJsonRecord(event.rate_limits) ? event.rate_limits : undefined;
  if (limits) {
    const windows = [limits.primary, limits.secondary]
      .map(window)
      .filter((w): w is UsageWindow => w !== null);
    if (windows.length > 0) {
      account = reportedLimits(windows, at);
    }
  }

  const info = isJsonRecord(event.info) ? event.info : undefined;
  const windowTokens = info ? asFiniteNumber(info.model_context_window) : undefined;
  // last_token_usage.total_tokens is the raw occupancy. Codex's own UI
  // removes its fixed baseline before presenting the user-controlled share.
  const inContext =
    info && isJsonRecord(info.last_token_usage)
      ? asFiniteNumber(info.last_token_usage.total_tokens)
      : undefined;
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
    reportedAt: at,
  };

  return { account, pane };
};
