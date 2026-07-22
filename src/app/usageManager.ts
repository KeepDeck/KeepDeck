import { isRecord } from "../domain/json";
import {
  freshest,
  mergePaneUsage,
  type AccountUsage,
  type PaneUsage,
  type UsageNormalizer,
} from "../domain/usage";
import { usageSourceTimestamp } from "./usageProvenance";

/**
 * The owner of live usage state — one per app, outside React, like
 * `notificationCenter`. Verified bridge reports funnel through
 * [`reportUsage`] (the channel hook authenticates tokens BEFORE calling —
 * this store never sees an unverified payload); [`useUsage`] reads the
 * snapshot via `useSyncExternalStore`.
 *
 * Two maps, two lifetimes: `accounts` (per provider, freshest-wins across
 * that provider's panes) OUTLIVES panes — closing the reporting pane must
 * not blank the chip; `panes` entries die with their pane
 * ([`retainUsagePanes`]). Everything is runtime-only, never persisted.
 *
 * Normalizers are registered per agent id — by the channel hook, from each
 * CLI plugin's `usage` contribution: the plugin owns its payload schema,
 * this store owns none of it.
 */

export interface UsageSnapshot {
  accounts: ReadonlyMap<string, AccountUsage>;
  panes: ReadonlyMap<string, PaneUsage>;
}

let accounts: ReadonlyMap<string, AccountUsage> = new Map();
let panes: ReadonlyMap<string, PaneUsage> = new Map();
let snapshot: UsageSnapshot = { accounts, panes };
const listeners = new Set<() => void>();
/** Provenance: keys that received LIVE (non-replay) data this run. A
 * catch-up replay merges like any report — the tailer deliberately splits
 * one arm into complementary partial events — but must never beat what a
 * live source already said. Gating on map membership instead of provenance
 * once dropped the second half of every replay (review finding). */
const liveAccounts = new Set<string>();
const livePanes = new Set<string>();

const normalizers = new Map<string, UsageNormalizer>();

function emit(): void {
  snapshot = { accounts, panes };
  for (const listener of [...listeners]) listener();
}

/** Register an agent's usage normalizer; returns the unregister. A second
 * registration for the same id replaces the first (last plugin wins, the
 * contribution-registry convention). */
export function registerUsageNormalizer(
  agentId: string,
  normalizer: UsageNormalizer,
): () => void {
  normalizers.set(agentId, normalizer);
  return () => {
    if (normalizers.get(agentId) === normalizer) normalizers.delete(agentId);
  };
}

/** Apply one VERIFIED bridge report. Unknown agents and unrecognizable
 * payloads are dropped silently — reporters are best-effort by design.
 *
 * `payload.catchUp` (a host-owned transport key, set by the tailer) marks
 * a replay of the EXISTING session file at arm time. Every tailed event has
 * an honest `sourceAt` plus `sourceMtimeMs` fallback; both replay and live
 * account claims use that provenance so delivery order cannot beat a newer
 * poll. A replay with no valid source time is stamped at epoch: it can fill
 * an empty store but cannot relabel unknown old data as current. The replay
 * mark remains a stronger guard: replay can fill and MERGE gaps but never
 * beat LIVE data from this run. */
export function reportUsage(
  paneId: string,
  payload: unknown,
  at = Date.now(),
): void {
  if (!isRecord(payload) || typeof payload.agent !== "string") return;
  const provider = payload.agent;
  const normalize = normalizers.get(provider);
  if (!normalize) return;
  const catchUp = payload.catchUp === true;
  const sourceAt =
    usageSourceTimestamp(payload.sourceAt, at) ??
    usageSourceTimestamp(payload.sourceMtimeMs, at);
  const result = normalize(payload, sourceAt ?? (catchUp ? 0 : at));
  if (!result) return;

  let changed = false;
  if (result.account && !(catchUp && liveAccounts.has(provider))) {
    if (!catchUp) liveAccounts.add(provider);
    const claimed: AccountUsage =
      result.account.kind === "reported"
        ? { ...result.account, sourcePaneId: paneId }
        : result.account;
    const current = accounts.get(provider);
    const next = freshest(current, claimed);
    if (next !== current) {
      accounts = new Map(accounts).set(provider, next);
      changed = true;
    }
  }
  if (result.pane && !(catchUp && livePanes.has(paneId))) {
    if (!catchUp) livePanes.add(paneId);
    // Merged, not replaced: codex splits model and numbers across events.
    panes = new Map(panes).set(
      paneId,
      mergePaneUsage(panes.get(paneId), result.pane),
    );
    changed = true;
  }
  if (changed) emit();
}

/** Apply an account-level document that arrived OUTSIDE the pane pipeline —
 * a native limits source. Freshest-wins like every account claim. */
export function setAccountUsage(provider: string, account: AccountUsage): void {
  const current = accounts.get(provider);
  const next = freshest(current, account);
  if (next === current) return;
  accounts = new Map(accounts).set(provider, next);
  emit();
}

/** Drop pane usage for panes that no longer exist. Account state stays —
 * the windows describe the account, not the pane that reported them. */
export function retainUsagePanes(liveIds: ReadonlySet<string>): void {
  for (const id of [...livePanes]) {
    if (!liveIds.has(id)) livePanes.delete(id);
  }
  if (![...panes.keys()].some((id) => !liveIds.has(id))) return;
  const next = new Map<string, PaneUsage>();
  for (const [id, usage] of panes) {
    if (liveIds.has(id)) next.set(id, usage);
  }
  panes = next;
  emit();
}

/** Start a pane's telemetry lifetime over. Used when its session generation
 * changes or its process is deliberately retired. Account state survives: it
 * describes the provider account, not this pane. Live provenance must reset
 * too so a resumed session's catch-up can seed the empty pane again. */
export function clearPaneUsage(paneId: string): void {
  livePanes.delete(paneId);
  if (!panes.has(paneId)) return;
  const next = new Map(panes);
  next.delete(paneId);
  panes = next;
  emit();
}

/** Accept a binding for a new session generation without erasing a report
 * from that same generation if filesystem delivery happened to overtake the
 * earlier `session.bound` envelope. */
export function beginPaneUsageSession(paneId: string, sessionId: string): void {
  if (panes.get(paneId)?.sessionId === sessionId) return;
  clearPaneUsage(paneId);
}

/** The live snapshot (stable between changes — the `useSyncExternalStore`
 * snapshot contract). */
export function getUsageSnapshot(): UsageSnapshot {
  return snapshot;
}

/** Notify on every snapshot change (the `useSyncExternalStore` contract). */
export function subscribeUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: forget the state, the registrations and every listener. */
export function resetUsageManager(): void {
  accounts = new Map();
  panes = new Map();
  snapshot = { accounts, panes };
  normalizers.clear();
  listeners.clear();
  liveAccounts.clear();
  livePanes.clear();
}
