import { isRecord } from "../domain/json";
import {
  freshest,
  mergePaneUsage,
  type AccountUsage,
  type PaneUsage,
  type UsageNormalizer,
} from "../domain/usage";

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
 * a replay of the EXISTING session file at arm time. Replays are stamped
 * with RECEIPT time like everything else, so without the mark a stale
 * snapshot from a freshly-armed pane would outrank genuinely fresher live
 * data under freshest-wins; marked reports apply (and MERGE — one arm is
 * several complementary partial events) unless the target already carries
 * LIVE data from this run. */
export function reportUsage(
  paneId: string,
  payload: unknown,
  at = Date.now(),
): void {
  if (!isRecord(payload) || typeof payload.agent !== "string") return;
  const provider = payload.agent;
  const normalize = normalizers.get(provider);
  if (!normalize) return;
  const result = normalize(payload, at);
  if (!result) return;
  const catchUp = payload.catchUp === true;

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
