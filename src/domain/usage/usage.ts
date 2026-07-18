import type { AccountUsage, PaneUsage } from "@keepdeck/plugin-api";

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
 * Incoming fields win, the context bag merges field-wise; a different agent
 * (pane respawned as another CLI) replaces wholesale. Relies on builders
 * OMITTING absent fields rather than setting them undefined. */
export function mergePaneUsage(
  current: PaneUsage | undefined,
  incoming: PaneUsage,
): PaneUsage {
  if (!current || current.agent !== incoming.agent) return incoming;
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
