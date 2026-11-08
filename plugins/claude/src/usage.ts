import {
  asFiniteNumber,
  asNonEmptyString,
  carriedRecord,
  clampPercent,
  isJsonRecord,
  percentWindow,
  reportedLimits,
  type AccountUsage,
  type ApiActivity,
  type CallTokens,
  type CarriedRecord,
  type PaneUsage,
  type TailWatch,
  type UsageCall,
  type UsageNormalizer,
  type UsageWindow,
} from "@keepdeck/plugin-api";

/**
 * Claude usage normalizer — this plugin owns the statusLine payload schema
 * its own reporter (kd-usage-statusline.sh) forwards verbatim:
 * `{agent:"claude", statusline: <the documented stdin JSON>}`, and the
 * transcript records it declares for itself below.
 *
 * Two sources, two jobs: the statusLine says how full the pane's context is
 * and where the account's limits stand; the transcript says which calls the
 * session made — each assistant message is one, booked by the usage history
 * and priced there — and, in its `cost-state` rows, claude's own running
 * total, which also counts the calls no row records.
 */

/**
 * Where claude keeps the transcripts of one session's subagents.
 *
 * A subagent writes its own turns to `<transcript-without-extension>/
 * subagents/**.jsonl` (a workflow's agents one level further down), and
 * those calls are the session's spend as much as the root file's — a
 * session whose work happened in subagents would otherwise report almost
 * nothing. Only its turn EDGES stay its own: a subagent's abort is not the
 * pane's.
 *
 * The host used to hold this rule, which meant a pane of every OTHER agent
 * paid a directory read per poll for a convention only claude has.
 */
export function claudeSubagentDirectory(store: string): string {
  return `${store.replace(/\.[^./]*$/, "")}/subagents`;
}

/**
 * The transcript rows that are calls: every assistant message that carries
 * counts.
 *
 * `keep` names the message's id, its model and its `usage` block — counts
 * and billing facts, no content: a transcript holds the conversation, and
 * a declaration that names no field of it cannot carry one out by accident.
 *
 * Claude writes one assistant message as several rows — one per content or
 * tool block — each restating the message's counts so far. Every row
 * travels; the usage history books a message once by its id and takes only
 * what each restatement grew.
 */
export const claudeUsageWatches: readonly TailWatch[] = [
  {
    match: [
      { key: "type", equals: "assistant" },
      { key: "message.id" },
      { key: "message.usage" },
    ],
    keep: ["message.id", "message.model", "message.usage"],
    lane: "calls",
  },
  // claude's own running count of the session's spend, model by model —
  // the only place the calls no row records leave their tokens: compaction,
  // "while you were away" summaries, prompt suggestions, titles. Written when
  // a process leaves the session (it exits, /clear, a switch, /bg).
  {
    match: [{ key: "type", equals: "cost-state" }, { key: "modelUsage" }],
    keep: ["startTime", "modelUsage"],
    lane: "calls",
  },
  // The latest dated row, held for the count after it: a cost-state row
  // carries no time, and the work it closes ended at the row before it. An
  // assistant row is the call watch's, so this holds the turn's last
  // bookkeeping row (its duration, its stop hook) — the moment work ended.
  {
    match: [{ key: "timestamp" }],
    keep: ["timestamp"],
    lane: "calls",
    context: true,
  },
];

/** The model claude names on a message it wrote itself — an API error, an
 * interruption — rather than one a model answered: no call was made. */
const SYNTHETIC_MODEL = "<synthetic>";

/** A count, or 0 for anything that is not one. */
function count(value: unknown): number {
  const counted = asFiniteNumber(value);
  return counted !== undefined && counted > 0 ? counted : 0;
}

/**
 * One claude `usage` block in the canonical classes.
 *
 * Claude counts its input FRESH and its cache read and write beside it, and
 * splits the write by how long it is held (`cache_creation.ephemeral_5m` /
 * `ephemeral_1h`); without the split, all of it is the 5-minute write. Its
 * output already holds the thinking, which it states as a share of it.
 */
function claudeTokens(usage: Record<string, unknown>): CallTokens {
  const written = count(usage.cache_creation_input_tokens);
  const split = isJsonRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const hour = split ? count(split.ephemeral_1h_input_tokens) : 0;
  const fiveMinutes = split
    ? (asFiniteNumber(split.ephemeral_5m_input_tokens) ?? Math.max(0, written - hour))
    : written;
  const details = isJsonRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  return {
    input: count(usage.input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(fiveMinutes),
    cacheWrite1h: hour,
    output: count(usage.output_tokens),
    reasoning: details ? count(details.thinking_tokens) : 0,
  };
}

/** The service-tier mode a claude `usage` block ran in: fast mode, or the
 * standard tier (absent). */
function claudeMode(usage: Record<string, unknown>, fallback?: Record<string, unknown>): string | undefined {
  const speed = asNonEmptyString(usage.speed) ?? (fallback ? asNonEmptyString(fallback.speed) : undefined);
  return speed === "fast" ? "fast" : undefined;
}

/**
 * The calls one transcript row records: the message itself, and each advisor
 * escalation inside it.
 *
 * The advisor tool (`/advisor`) consults a stronger model mid-turn; its
 * tokens are recorded under that model in `usage.iterations` as
 * `advisor_message` entries and are NOT in the message's own counts — so
 * each is a call of its own, keyed by its ordinal among them.
 */
function claudeCalls(carried: CarriedRecord): UsageCall[] {
  const { record, at } = carried;
  const id = asNonEmptyString(record["message.id"]);
  const model = asNonEmptyString(record["message.model"]);
  const usage = record["message.usage"];
  if (!id || !model || model === SYNTHETIC_MODEL || !isJsonRecord(usage) || at === undefined) {
    return [];
  }
  const mode = claudeMode(usage);
  const calls: UsageCall[] = [
    {
      id,
      at,
      provider: "anthropic",
      model: claudeModelId(model),
      ...(mode ? { mode } : {}),
      tokens: claudeTokens(usage),
    },
  ];
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  let advisor = 0;
  for (const iteration of iterations) {
    if (!isJsonRecord(iteration) || iteration.type !== "advisor_message") continue;
    const ordinal = advisor++;
    const advisorModel = asNonEmptyString(iteration.model) ?? model;
    const advisorMode = claudeMode(iteration, usage);
    calls.push({
      id: `${id}:advisor:${ordinal}`,
      at,
      provider: "anthropic",
      model: claudeModelId(advisorModel),
      ...(advisorMode ? { mode: advisorMode } : {}),
      tokens: claudeTokens(iteration),
    });
  }
  return calls;
}

/** One model's counts in a `cost-state` row, in the canonical classes: the
 * same convention as a message's `usage`, under claude's camel-case names. */
function costStateTokens(usage: Record<string, unknown>): CallTokens {
  const hour = count(usage.cacheCreationEphemeral1hInputTokens);
  const fiveMinutes =
    asFiniteNumber(usage.cacheCreationEphemeral5mInputTokens) ??
    Math.max(0, count(usage.cacheCreationInputTokens) - hour);
  return {
    input: count(usage.inputTokens),
    cacheRead: count(usage.cacheReadInputTokens),
    cacheWrite: count(fiveMinutes),
    cacheWrite1h: hour,
    output: count(usage.outputTokens),
    reasoning: count(usage.thinkingTokens),
  };
}

/**
 * claude's running totals out of one `cost-state` row: one per model, the
 * count that began at the row's `startTime` (a session's line of processes —
 * resumed ones continue it, `/clear` starts a new one), dated by the latest
 * row before it. The main loop counts under `claude-opus-5-5[1m]`, a side job
 * under the bare id: one model, so one total.
 */
function claudeTotals(carried: CarriedRecord): UsageCall[] {
  const began = asFiniteNumber(carried.record.startTime);
  const models = carried.record.modelUsage;
  const stamp = carried.context ? asNonEmptyString(carried.context.timestamp) : undefined;
  const at = stamp === undefined ? Number.NaN : Date.parse(stamp);
  if (began === undefined || !isJsonRecord(models) || !Number.isFinite(at)) return [];
  const totals = new Map<string, CallTokens>();
  for (const [name, usage] of Object.entries(models)) {
    if (!isJsonRecord(usage)) continue;
    const model = claudeModelId(name);
    const tokens = costStateTokens(usage);
    const held = totals.get(model);
    totals.set(model, held ? sumTokens(held, tokens) : tokens);
  }
  return [...totals].map(([model, tokens]) => ({
    id: `${began}:${model}`,
    at,
    provider: "anthropic",
    model,
    tokens,
    tally: { began },
  }));
}

function sumTokens(a: CallTokens, b: CallTokens): CallTokens {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0),
    output: a.output + b.output,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
  };
}

/**
 * A model id as the API knows it: the statusLine names the model claude was
 * asked for with its one-million-token context as a suffix
 * (`claude-opus-5-5[1m]`), which no catalogue lists.
 */
function claudeModelId(id: string): string {
  return id.replace(/\[[^\]]*\]$/, "");
}

const WINDOW_MINUTES: Record<string, number> = {
  five_hour: 300,
  seven_day: 10_080,
};

/** One rate_limits window ({used_percentage, resets_at seconds}) →
 * normalized, or null when the shape is off. */
function window(
  value: unknown,
  windowMinutes: number | null,
  scope?: string,
): UsageWindow | null {
  if (!isJsonRecord(value)) return null;
  return percentWindow({
    usedPct: value.used_percentage,
    resetsAtSeconds: value.resets_at,
    windowMinutes,
    scope,
  });
}

/**
 * Account: `rate_limits` maps keys → windows by the known-minutes table;
 * the claim counts only behind an API-activity witness ([`apiActivity`]);
 * unknown keys of the same shape still normalize (windowMinutes null,
 * scoped) so a future window appears instead of vanishing. Absent
 * rate_limits is NEVER a claim: a resumed subscription session reports
 * accumulated cost>0 from its very first update, BEFORE rate_limits shows
 * up (field report: a Max account dimmed to "--"), so cost proves nothing
 * about billing. API-key accounts simply never produce windows — no chip.
 */
export const normalizeClaudeStatusline: UsageNormalizer = (payload, at) => {
  if (!isJsonRecord(payload)) return null;
  const carried = carriedRecord(payload);
  if (carried) {
    const calls = "modelUsage" in carried.record ? claudeTotals(carried) : claudeCalls(carried);
    return { account: null, pane: null, calls };
  }
  const line = payload.statusline;
  if (!isJsonRecord(line)) return null;

  let account: AccountUsage | null = null;
  const limits = line.rate_limits;
  if (isJsonRecord(limits)) {
    const windows: UsageWindow[] = [];
    for (const [key, value] of Object.entries(limits)) {
      const known: number | undefined = WINDOW_MINUTES[key];
      const parsed = window(
        value,
        known ?? null,
        known === undefined ? key : undefined,
      );
      if (parsed) windows.push(parsed);
    }
    if (windows.length > 0) {
      account = reportedLimits(windows, at);
    }
  }
  const cost = isJsonRecord(line.cost)
    ? asFiniteNumber(line.cost.total_cost_usd)
    : undefined;
  const apiDurationMs = isJsonRecord(line.cost)
    ? asFiniteNumber(line.cost.total_api_duration_ms)
    : undefined;
  const sessionId = asNonEmptyString(line.session_id);

  const context = isJsonRecord(line.context_window)
    ? line.context_window
    : undefined;
  const usedPct = context ? asFiniteNumber(context.used_percentage) : undefined;
  const windowTokens = context
    ? asFiniteNumber(context.context_window_size)
    : undefined;

  const pane: PaneUsage = {
    agent: "claude",
    ...(sessionId ? { sessionId } : {}),
    ...(usedPct !== undefined
      ? {
          context: {
            usedPct: clampPercent(usedPct),
            ...(windowTokens !== undefined ? { windowTokens } : {}),
          },
        }
      : {}),
    reportedAt: at,
  };

  return { account, pane, accountActivity: apiActivity(sessionId, cost, apiDurationMs) };
};

/**
 * The witness that gates every statusline account claim. The statusLine
 * re-runs on its refresh timer and re-sends whatever limits the process last
 * received, so the limits alone cannot say they are new; these two session
 * cumulatives move on every API call — subagents' included, whose responses
 * refresh the same account limits — and on nothing else. NOT
 * `context_window.total_*` or `current_usage`: those describe the current
 * response, and repeat or fall between calls. Missing or odd counters are no
 * witness (`null`), never a fallback to an ungated claim.
 */
function apiActivity(
  sessionId: string | undefined,
  costUsd: number | undefined,
  apiDurationMs: number | undefined,
): ApiActivity | null {
  if (
    sessionId === undefined ||
    costUsd === undefined ||
    apiDurationMs === undefined ||
    costUsd < 0 ||
    apiDurationMs < 0
  ) {
    return null;
  }
  return { sessionId, costUsd, apiDurationMs };
}
