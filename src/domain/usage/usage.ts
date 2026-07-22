import type { AccountUsage, PaneUsage, UsageWindow } from "@keepdeck/plugin-api";

/**
 * Usage domain — the host-side rules over the usage contract. The TYPES and
 * the per-agent normalizers live with their owners: shapes in
 * `@keepdeck/plugin-api` (`context/usage.ts`), normalizers in each CLI
 * plugin (they own their CLI's payload schema, registered through the
 * agents contribution). What remains here is what no plugin may decide:
 * how reports COMBINE.
 *
 * Two facts with different owners, kept apart on purpose:
 *  - account-level rate-limit WINDOWS are per provider, not per pane —
 *    every pane of a provider reports the same account, so reports collapse
 *    freshest-wins ([`freshest`]);
 *  - PANE usage (context, tokens, cost) belongs to one live session, and
 *    partial reports complete each other ([`mergePaneUsage`]).
 *
 * Everything is runtime state (the `gitPositions` precedent) — none of it
 * is persisted into deck.json. Time is always injected so the functions
 * stay pure and testable.
 */

export type {
  AccountUsage,
  NormalizedUsage,
  PaneUsage,
  TokenCounts,
  UsageNormalizer,
  UsageWindow,
} from "@keepdeck/plugin-api";

/** Freshest-wins collapse for account reports: a newer report replaces an
 * older one; ties keep the incumbent (stability under same-ms bursts). */
export function freshest(
  current: AccountUsage | undefined,
  incoming: AccountUsage,
): AccountUsage {
  if (!current) return incoming;
  return incoming.reportedAt > current.reportedAt ? incoming : current;
}

/** Merge a pane's usage across partial reports: codex delivers the model
 * (`turn_context`) and the numbers (`token_count`) as separate events, kimi
 * splits window size from token counts — neither may erase the other.
 * Incoming fields win, the context bag merges field-wise. A different agent
 * or an explicitly different session replaces wholesale; a lower sequence in
 * the same session is an out-of-order delivery and is ignored. Relies on
 * builders OMITTING absent fields rather than setting them undefined. */
export function mergePaneUsage(
  current: PaneUsage | undefined,
  incoming: PaneUsage,
): PaneUsage {
  if (!current || current.agent !== incoming.agent) return incoming;
  if (
    incoming.sessionId !== undefined &&
    current.sessionId !== incoming.sessionId
  ) {
    return incoming;
  }
  if (
    incoming.sequence !== undefined &&
    current.sequence !== undefined &&
    incoming.sequence < current.sequence
  ) {
    return current;
  }
  const context =
    current.context || incoming.context
      ? { ...current.context, ...incoming.context }
      : undefined;
  return { ...current, ...incoming, ...(context ? { context } : {}) };
}

/** The percentage a context bag amounts to, however it was reported. */
export function contextPct(
  context: PaneUsage["context"],
): number | undefined {
  if (!context) return undefined;
  if (context.usedPct !== undefined) return context.usedPct;
  if (
    context.usedTokens !== undefined &&
    context.windowTokens !== undefined &&
    context.windowTokens > 0
  ) {
    return Math.min(
      100,
      Math.max(0, (context.usedTokens / context.windowTokens) * 100),
    );
  }
  return undefined;
}

/** A window whose reset instant has passed is provably outdated — its
 * percentage describes the PREVIOUS window. The UI dims it instead of
 * lying confidently. */
export function windowExpired(
  window: { resetsAt: number | null },
  now: number,
): boolean {
  return window.resetsAt !== null && now >= window.resetsAt;
}

/* ---- The usage cache: last-known account snapshots across restarts ---- *
 * A cold-started bar showing NOTHING until each CLI happens to speak reads
 * as broken; the last session's windows, honestly aged (stale-dimmed,
 * "Updated Xh ago"), read as a dashboard. Pane usage deliberately does NOT
 * persist — sessions die with their panes. */

/** A reserved forward-compat stamp, WRITTEN but deliberately never read:
 * the tolerant per-entry reader below IS the migration mechanism while the
 * shape stays additive. If a future revision changes an entry's MEANING,
 * that is the moment to start gating on this field — do not assume the
 * reader already rejects mismatches. */
const USAGE_CACHE_VERSION = 1;

/** Serialize the account map for the cache file. */
export function serializeUsageCache(
  accounts: ReadonlyMap<string, AccountUsage>,
): string {
  return JSON.stringify({
    version: USAGE_CACHE_VERSION,
    accounts: Object.fromEntries(accounts),
  });
}

function readWindow(value: unknown): { window: UsageWindow } | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.usedPct !== "number" || !Number.isFinite(raw.usedPct)) return null;
  return {
    window: {
      usedPct: Math.min(100, Math.max(0, raw.usedPct)),
      resetsAt:
        typeof raw.resetsAt === "number" && Number.isFinite(raw.resetsAt)
          ? raw.resetsAt
          : null,
      windowMinutes:
        typeof raw.windowMinutes === "number" && Number.isFinite(raw.windowMinutes)
          ? raw.windowMinutes
          : null,
      ...(typeof raw.scope === "string" && raw.scope !== ""
        ? { scope: raw.scope }
        : {}),
    },
  };
}

/** Tolerant read of a cache file: entries that don't parse are dropped
 * individually — a damaged cache costs stale chips, never a boot. Only
 * `reported` accounts are kept (the cache exists to fill the bar). */
export function hydrateUsageCache(json: string): Map<string, AccountUsage> {
  const out = new Map<string, AccountUsage>();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return out;
  }
  if (typeof raw !== "object" || raw === null) return out;
  const accounts = (raw as Record<string, unknown>).accounts;
  if (typeof accounts !== "object" || accounts === null) return out;
  for (const [provider, entry] of Object.entries(accounts)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (e.kind !== "reported") continue;
    if (typeof e.reportedAt !== "number" || !Number.isFinite(e.reportedAt)) continue;
    if (!Array.isArray(e.windows)) continue;
    const windows = e.windows
      .map(readWindow)
      .filter((w): w is { window: UsageWindow } => w !== null)
      .map((w) => w.window);
    if (windows.length === 0) continue;
    out.set(provider, {
      kind: "reported",
      windows,
      reportedAt: e.reportedAt,
      sourcePaneId: "",
    });
  }
  return out;
}
