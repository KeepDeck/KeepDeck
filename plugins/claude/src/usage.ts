import {
  asFiniteNumber,
  asNonEmptyString,
  clampPercent,
  collectTokenCounts,
  isJsonRecord,
  type AccountUsage,
  type PaneUsage,
  type UsageNormalizer,
  type UsageWindow,
} from "@keepdeck/plugin-api";

/**
 * Claude usage normalizer — this plugin owns the statusLine payload schema
 * its own reporter (kd-usage-statusline.sh) forwards verbatim:
 * `{agent:"claude", statusline: <the documented stdin JSON>}`.
 */

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
  const totalTokens = context
    ? collectTokenCounts({
        input: context.total_input_tokens,
        output: context.total_output_tokens,
        cacheRead: undefined,
        cacheWrite: undefined,
        reasoning: undefined,
        total: undefined,
      })
    : undefined;
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
    ...(totalTokens ? { totalTokens } : {}),
    ...(lastTurnTokens ? { lastTurnTokens } : {}),
    reportedAt: at,
  };

  return { account, pane };
};
