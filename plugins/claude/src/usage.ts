import {
  asFiniteNumber,
  asNonEmptyString,
  carriedUsageRecord,
  clampPercent,
  collectTokenCounts,
  isJsonRecord,
  type AccountUsage,
  type PaneUsage,
  type TailWatch,
  type UsageNormalizer,
  type UsageWindow,
} from "@keepdeck/plugin-api";

/**
 * Claude usage normalizer — this plugin owns the statusLine payload schema
 * its own reporter (kd-usage-statusline.sh) forwards verbatim:
 * `{agent:"claude", statusline: <the documented stdin JSON>}`, and the
 * transcript records it declares for itself below.
 */

/**
 * Where claude keeps the transcripts of one session's subagents.
 *
 * A subagent writes its own turns to `<transcript-without-extension>/
 * subagents/*.jsonl`, and those rows are the session's cost as much as the
 * root file's — a session whose work happened in subagents would otherwise
 * report almost nothing. Only its turn EDGES stay its own: a subagent's
 * abort is not the pane's.
 *
 * The host used to hold this rule, which meant a pane of every OTHER agent
 * paid a directory read per poll for a convention only claude has.
 */
export function claudeSubagentDirectory(store: string): string {
  return `${store.replace(/\.[^./]*$/, "")}/subagents`;
}

/**
 * What a claude transcript is worth reading for the numbers, and what a
 * session total over it is made of.
 *
 * `keep` is EMPTY, and that is the whole shape of the answer: nothing about
 * an assistant message needs to leave the transcript, only the total folded
 * from it. A transcript holds the conversation, and a declaration that names
 * no field of it cannot carry one out by accident.
 *
 * `dedupBy` is the fact only this side knows. Claude writes one assistant
 * message as several rows — one per content or tool block — each restating
 * the message's counts so far. Added plainly, a turn would cost as many
 * times as it had blocks; held at each bucket's maximum, it costs once.
 */
export const claudeUsageWatches: readonly TailWatch[] = [
  {
    match: [
      { key: "type", equals: "assistant" },
      { key: "message.id" },
      { key: "message.usage" },
    ],
    keep: [],
    lane: "usage",
    sum: {
      buckets: {
        input_tokens: "message.usage.input_tokens",
        output_tokens: "message.usage.output_tokens",
        cache_read_input_tokens: "message.usage.cache_read_input_tokens",
        cache_creation_input_tokens: "message.usage.cache_creation_input_tokens",
      },
      dedupBy: "message.id",
      stampAs: "sessionTotals",
    },
  },
];

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
  const usedPct = asFiniteNumber(value.used_percentage);
  if (usedPct === undefined) return null;
  const resetsAt = asFiniteNumber(value.resets_at);
  return {
    usedPct: clampPercent(usedPct),
    resetsAt: resetsAt !== undefined ? resetsAt * 1000 : null,
    windowMinutes,
    ...(scope ? { scope } : {}),
  };
}

/**
 * Account: `rate_limits` maps keys → windows by the known-minutes table;
 * unknown keys of the same shape still normalize (windowMinutes null,
 * scoped) so a future window appears instead of vanishing. Absent
 * rate_limits is NEVER a claim: a resumed subscription session reports
 * accumulated cost>0 from its very first update, BEFORE rate_limits shows
 * up (field report: a Max account dimmed to "--"), so cost proves nothing
 * about billing. API-key accounts simply never produce windows — no chip.
 */
export const normalizeClaudeStatusline: UsageNormalizer = (payload, at) => {
  if (!isJsonRecord(payload)) return null;
  const tailed = carriedUsageRecord(payload);
  if (tailed) {
    const totals = isJsonRecord(tailed.sessionTotals)
      ? tailed.sessionTotals
      : undefined;
    const totalTokens = totals
      ? collectTokenCounts({
          input: totals.input_tokens,
          output: totals.output_tokens,
          cacheRead: totals.cache_read_input_tokens,
          cacheWrite: totals.cache_creation_input_tokens,
          reasoning: undefined,
          total: undefined,
        })
      : undefined;
    if (!totalTokens) return { account: null, pane: null };
    return {
      account: null,
      pane: {
        agent: "claude",
        totalTokens,
        reportedAt: at,
      },
    };
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
      account = { kind: "reported", windows, reportedAt: at, sourcePaneId: "" };
    }
  }
  const cost = isJsonRecord(line.cost)
    ? asFiniteNumber(line.cost.total_cost_usd)
    : undefined;

  const model = isJsonRecord(line.model) ? line.model : undefined;
  const modelName = model
    ? (asNonEmptyString(model.display_name) ?? asNonEmptyString(model.id))
    : undefined;
  const context = isJsonRecord(line.context_window)
    ? line.context_window
    : undefined;
  const usedPct = context ? asFiniteNumber(context.used_percentage) : undefined;
  const windowTokens = context
    ? asFiniteNumber(context.context_window_size)
    : undefined;
  const current =
    context && isJsonRecord(context.current_usage)
      ? context.current_usage
      : undefined;
  // Since Claude Code 2.1.132 the statusLine's `total_*` fields describe the
  // CURRENT context/response, not cumulative session usage. Durable totals
  // come from the transcript tail above; current_usage remains useful only as
  // the live last-turn breakdown.
  const lastTurnTokens = current
    ? collectTokenCounts({
        input: current.input_tokens,
        output: current.output_tokens,
        cacheRead: current.cache_read_input_tokens,
        cacheWrite: current.cache_creation_input_tokens,
        reasoning: undefined,
        total: undefined,
      })
    : undefined;

  const pane: PaneUsage = {
    agent: "claude",
    ...(asNonEmptyString(line.session_id)
      ? { sessionId: asNonEmptyString(line.session_id) }
      : {}),
    ...(modelName ? { model: modelName } : {}),
    ...(usedPct !== undefined
      ? {
          context: {
            usedPct: clampPercent(usedPct),
            ...(windowTokens !== undefined ? { windowTokens } : {}),
          },
        }
      : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(lastTurnTokens ? { lastTurnTokens } : {}),
    reportedAt: at,
  };

  return { account, pane };
};
