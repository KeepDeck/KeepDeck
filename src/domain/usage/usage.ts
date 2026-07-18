import { isRecord } from "../json";

/**
 * Usage domain — the normalized shapes behind the top-bar limit chips and
 * the per-pane usage details, plus the per-agent normalizers that produce
 * them from raw bridge payloads.
 *
 * Two facts with different owners, kept apart on purpose:
 *  - account-level rate-limit WINDOWS are per provider, not per pane —
 *    every pane of a provider reports the same account, so reports collapse
 *    freshest-wins ([`freshest`]);
 *  - PANE usage (context, tokens, cost) belongs to one live session.
 *
 * Everything here is runtime state (the `gitPositions` precedent) — none of
 * it is persisted into deck.json. Time is always injected (`at`, `now`) so
 * the functions stay pure and testable.
 */

/** One provider rate-limit window, normalized across CLIs. Labels derive
 * from `windowMinutes` — NEVER from field position: codex on some plans
 * reports a weekly window as `primary` with no 5h window at all. */
export interface UsageWindow {
  /** 0–100, share of the window consumed. */
  usedPct: number;
  /** Absolute reset instant, unix MILLISECONDS (null = the CLI didn't say).
   * Countdowns are computed client-side from this — an idle pane stops
   * reporting, the clock must keep ticking. */
  resetsAt: number | null;
  /** Window length in minutes (300 = 5h, 10080 = weekly, 43200 = monthly). */
  windowMinutes: number | null;
  /** Model-scoped windows carry their scope (e.g. "fable" weekly);
   * account-wide windows leave it undefined. */
  scope?: string;
}

/** The account-level state of one provider — a claim, or the reasoned
 * absence of one. Modeled as a union so a chip can't render limits and
 * "unavailable" at once. */
export type AccountUsage =
  | {
      kind: "reported";
      windows: UsageWindow[];
      reportedAt: number;
      /** The pane whose report won freshest-wins — diagnostics only. */
      sourcePaneId: string;
    }
  | {
      kind: "unavailable";
      /** Why there are no windows: API-key billing has no plan windows. */
      reason: "api-key";
      reportedAt: number;
    };

/** Token counts as a CLI reports them; every field optional — providers
 * disagree on what they expose. */
export interface TokenCounts {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
}

/** One pane's live session usage — collected from day one, rendered by the
 * details view (and later the pane-header context chip). */
export interface PaneUsage {
  agent: string;
  sessionId?: string;
  /** Human model name ("Opus") when the CLI offers one; else the raw id. */
  model?: string;
  context?: {
    usedPct: number;
    /** The model's context window size in tokens, when reported. */
    windowTokens?: number;
  };
  costUsd?: number;
  totalTokens?: TokenCounts;
  lastTurnTokens?: TokenCounts;
  reportedAt: number;
}

/** What one bridge report normalizes into. `account: null` means the report
 * made no account-level claim (too early to tell — distinct from
 * "unavailable", which is a positive claim of absence). */
export interface NormalizedUsage {
  account: AccountUsage | null;
  pane: PaneUsage | null;
}

/** A per-agent normalizer: raw bridge payload → normalized usage, or null
 * when the payload is not recognizable. Registered per agent id — the agent
 * plugin owns its payload schema. */
export type UsageNormalizer = (payload: unknown, at: number) => NormalizedUsage | null;

const clampPct = (value: number): number => Math.min(100, Math.max(0, value));

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** Freshest-wins collapse for account reports: a newer report replaces an
 * older one; ties keep the incumbent (stability under same-ms bursts). */
export function freshest(
  current: AccountUsage | undefined,
  incoming: AccountUsage,
): AccountUsage {
  if (!current) return incoming;
  return incoming.reportedAt > current.reportedAt ? incoming : current;
}

/** A window whose reset instant has passed is provably outdated — its
 * percentage describes the PREVIOUS window. The UI dims it instead of
 * lying confidently. */
export function windowExpired(window: UsageWindow, now: number): boolean {
  return window.resetsAt !== null && now >= window.resetsAt;
}

/** One claude rate_limits window ({used_percentage, resets_at seconds}) →
 * normalized, or null when the shape is off. */
function claudeWindow(
  value: unknown,
  windowMinutes: number | null,
  scope?: string,
): UsageWindow | null {
  if (!isRecord(value)) return null;
  const usedPct = asNumber(value.used_percentage);
  if (usedPct === undefined) return null;
  const resetsAt = asNumber(value.resets_at);
  return {
    usedPct: clampPct(usedPct),
    resetsAt: resetsAt !== undefined ? resetsAt * 1000 : null,
    windowMinutes,
    ...(scope ? { scope } : {}),
  };
}

/** Collect present token fields; undefined when none are — an empty counts
 * object would read as "reported zero of everything". */
function tokenCounts(
  fields: Record<keyof TokenCounts, unknown>,
): TokenCounts | undefined {
  const counts: TokenCounts = {};
  for (const [key, raw] of Object.entries(fields)) {
    const value = asNumber(raw);
    if (value !== undefined) counts[key as keyof TokenCounts] = value;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

const CLAUDE_WINDOW_MINUTES: Record<string, number> = {
  five_hour: 300,
  seven_day: 10_080,
};

/**
 * Normalize one claude statusLine report (`{agent:"claude", statusline}`,
 * the stdin JSON forwarded verbatim by kd-usage-statusline.sh).
 *
 * Account: `rate_limits` maps keys → windows by the known-minutes table;
 * unknown keys of the same shape still normalize (windowMinutes null) so a
 * future window appears instead of vanishing. Absent rate_limits is
 * "unavailable (api-key)" only once cost proves the API has answered —
 * docs: the field exists on subscription plans after the first response —
 * and `null` (no claim) before that.
 */
export const normalizeClaudeStatusline: UsageNormalizer = (payload, at) => {
  if (!isRecord(payload)) return null;
  const line = payload.statusline;
  if (!isRecord(line)) return null;

  let account: AccountUsage | null = null;
  const limits = line.rate_limits;
  if (isRecord(limits)) {
    const windows: UsageWindow[] = [];
    for (const [key, value] of Object.entries(limits)) {
      const known: number | undefined = CLAUDE_WINDOW_MINUTES[key];
      const window = claudeWindow(
        value,
        known ?? null,
        known === undefined ? key : undefined,
      );
      if (window) windows.push(window);
    }
    if (windows.length > 0) {
      account = { kind: "reported", windows, reportedAt: at, sourcePaneId: "" };
    }
  }
  const cost = isRecord(line.cost) ? asNumber(line.cost.total_cost_usd) : undefined;
  if (!account && cost !== undefined && cost > 0) {
    account = { kind: "unavailable", reason: "api-key", reportedAt: at };
  }

  const model = isRecord(line.model) ? line.model : undefined;
  const modelName = model
    ? (asString(model.display_name) ?? asString(model.id))
    : undefined;
  const context = isRecord(line.context_window) ? line.context_window : undefined;
  const usedPct = context ? asNumber(context.used_percentage) : undefined;
  const windowTokens = context ? asNumber(context.context_window_size) : undefined;
  const current =
    context && isRecord(context.current_usage) ? context.current_usage : undefined;
  const totalTokens = context
    ? tokenCounts({
        input: context.total_input_tokens,
        output: context.total_output_tokens,
        cacheRead: undefined,
        cacheWrite: undefined,
        reasoning: undefined,
        total: undefined,
      })
    : undefined;
  const lastTurnTokens = current
    ? tokenCounts({
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
    ...(asString(line.session_id) ? { sessionId: asString(line.session_id) } : {}),
    ...(modelName ? { model: modelName } : {}),
    ...(usedPct !== undefined
      ? {
          context: {
            usedPct: clampPct(usedPct),
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
