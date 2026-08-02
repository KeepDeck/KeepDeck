/**
 * The per-pane spawn-plan cache: what each pane's plan currently is, whether
 * one is being built, and whether the last build failed.
 *
 * Module state on purpose — the plans outlive any component, and a build
 * generation per pane is what makes invalidation real (dropping a spec while
 * its build is in flight must make that build land nowhere).
 */
import type { ResumeOrigin, SpawnPlan } from "../../domain/agents";
import type { BuiltPlan } from "./plan";

/**
 * Spawn plans, built through the cli plugins' hooks ([F7]/[F8] v2).
 *
 * A pane's plan is the output of its agent plugin's `spawn.plan` /
 * `resume.plan` hook — argv, env, config injection — plus the HOST-owned
 * bridge arming: the single `KEEPDECK_BRIDGE` env var (inbox dir, pane
 * correlation, anti-forgery token) is appended here, never by a plugin;
 * plugins don't see the bridge.
 *
 * One plan per pane id, stable for the pane's life — module scope like the
 * id mints. Stability matters: the plan carries the pane's bridge token,
 * and re-building on a later render would orphan the token its reporter is
 * about to echo. Hooks are async, so plans land in the cache a beat after
 * the pane appears; the pane's terminal waits for its plan (mounting is
 * what spawns).
 */
const specs = new Map<string, SpawnPlan>();

/** Panes whose CURRENT build is in flight — a StrictMode re-run must not
 * build a second time. A manual resume reserves the same slot before its
 * first await, so the ordinary fresh-plan sweep cannot race it. */
const pending = new Set<string>();

/** Panes whose last plan build FAILED (a remote spawn.plan threw, which
 * propagates instead of silently degrading to a local spawn). The deck shows
 * an error tile rather than leaving the pane on "Waking up…" forever, and the
 * sweep skips them so a persistent error doesn't loop. Cleared by an explicit
 * retry (`clearPanePlanError`). */
const failed = new Set<string>();

/** Per-pane build generations make invalidation real: dropping a spec while
 * an async hook is running prevents that stale promise from installing its
 * result after a newer manual/fresh decision. */
const buildGenerations = new Map<string, number>();

/**
 * Who to tell when the answer to "what does this pane run" changes.
 *
 * This cache has several writers — the ordinary sweep, a manual resume, a
 * fork's surgery, a retry — and one of them landing is exactly what a pane
 * waiting to start, or a card waiting to stop saying "Waking up…", is waiting
 * FOR. Without a notification each writer had to remember to poke whoever
 * cared, and the ones reached through an await did not: a resumed pane got a
 * real process and a view that never learned its plan existed.
 *
 * The registry beside it ([`subscribeSessions`]) already worked this way. A
 * module-level store that mutates behind an await needs a way to say so.
 */
const specListeners = new Set<() => void>();

/** Tell me when any pane's plan, or its build failure, changes. */
export function subscribeSpawnSpecs(listener: () => void): () => void {
  specListeners.add(listener);
  return () => {
    specListeners.delete(listener);
  };
}

function notifySpecs(): void {
  for (const listener of [...specListeners]) listener();
}

function reserveBuild(paneId: string): number {
  const generation = (buildGenerations.get(paneId) ?? 0) + 1;
  buildGenerations.set(paneId, generation);
  pending.add(paneId);
  return generation;
}

export async function buildAndCache(
  paneId: string,
  build: () => Promise<BuiltPlan>,
): Promise<boolean> {
  const generation = reserveBuild(paneId);
  try {
    const built = await build();
    if (buildGenerations.get(paneId) !== generation) return false;
    pending.delete(paneId);
    specs.set(paneId, built.plan);
    failed.delete(paneId);
    // The plan's on-disk half, and only now: the generation check above is
    // the OTHER half of "is this plan settled", and a build it discards must
    // not have written a config naming a secret this cache never holds.
    // Before the listeners, because one of them is what starts the process
    // that reads the file.
    await built.deliver();
    notifySpecs();
    return true;
  } catch (error) {
    if (buildGenerations.get(paneId) === generation) {
      pending.delete(paneId);
      // Record the failure so the deck can surface an error tile instead of
      // hanging on "Waking up…" — a remote spawn that can't build its plan
      // must not silently become a local one (the reason buildPlan rethrows).
      failed.add(paneId);
      notifySpecs();
    }
    throw error;
  }
}

/** Forget a pane's plan so the next build starts clean (the respawn-fresh
 * path after a dead resume). */
export function dropPaneSpawnSpec(paneId: string): void {
  specs.delete(paneId);
  pending.delete(paneId);
  failed.delete(paneId);
  buildGenerations.set(paneId, (buildGenerations.get(paneId) ?? 0) + 1);
  // Last, for the same reason as its sibling below: a listener that reacts by
  // starting a build must see the invalidation it is reacting to. Notifying
  // first would let that build reserve a generation this line then bumps past,
  // and a build that loses its generation never leaves `pending` — the pane
  // would be skipped by every later sweep.
  notifySpecs();
}

/** The cached plan, if any (no building) — for the binding effect. */
export function peekPaneSpawnSpec(paneId: string): SpawnPlan | undefined {
  return specs.get(paneId);
}

/** Capture the first accepted local binding produced by a fork plan. This is
 * intentionally one-shot: a later `/new` in the same process is fresh usage. */
export function bindPaneSpawnSpecSession(
  paneId: string,
  sessionId: string,
): void {
  const spec = specs.get(paneId);
  if (!spec?.forkOf || spec.forkSessionId) return;
  specs.set(paneId, { ...spec, forkSessionId: sessionId });
  notifySpecs();
}

/** Re-stamp WHO asked for a cached resume plan. The origin is a field of the
 * assembled plan and never reaches the agent's `resume.plan` hook, so a wake
 * whose requester changes mid-build has nothing to re-derive: rebuilding
 * would run a third party's hook a second time for something it cannot see,
 * and nothing forbids that hook from having effects. Only a resume plan has
 * an origin; anything else is left alone. */
export function markPaneResumeOrigin(paneId: string, origin: ResumeOrigin): void {
  const spec = specs.get(paneId);
  if (!spec?.resumeOf) return;
  specs.set(paneId, { ...spec, resumeOrigin: origin });
  notifySpecs();
}


/** Whether this pane's last plan build FAILED (a remote spawn.plan threw).
 *  The deck renders an error tile instead of "Waking up…" — the build won't
 *  be retried until the user asks (`clearPanePlanError`). */
export function peekPanePlanError(paneId: string): boolean {
  return failed.has(paneId);
}

/** Clear a pane's failed-plan flag and invalidate any in-flight build so the
 *  next sweep rebuilds it (the retry button on the error tile). */
export function clearPanePlanError(paneId: string): void {
  failed.delete(paneId);
  pending.delete(paneId);
  buildGenerations.set(paneId, (buildGenerations.get(paneId) ?? 0) + 1);
  // Last, so a listener that reacts by rebuilding sees the invalidation it
  // is reacting to rather than the generation it is about to replace.
  notifySpecs();
}

/** Test isolation. Listeners go with the rest of the state: a subscriber
 * outliving the cache it watches would keep reacting to a later test's
 * writes. */
export function resetPaneSpawnSpecs(): void {
  specs.clear();
  pending.clear();
  failed.clear();
  buildGenerations.clear();
  specListeners.clear();
}

/** Whether a pane already has a cached plan. */
export function hasPaneSpawnSpec(paneId: string): boolean {
  return specs.has(paneId);
}

/** Whether a pane's plan build is in flight (a StrictMode re-run must not
 * start a second one). */
export function isPaneSpawnSpecPending(paneId: string): boolean {
  return pending.has(paneId);
}

/** The pane whose CURRENT plan carries this MCP secret, or null.
 *
 * The cache IS the registry of live secrets — no second store to keep in
 * sync: every path that retires a process drops the spec first, so a secret
 * stops resolving exactly when the process it was minted for goes away. A
 * lingering MCP child of a dead pane therefore resolves to nobody, rather
 * than to whoever inherited its reusable `pane-N` slot.
 */
export function paneIdByMcpToken(token: string): string | null {
  for (const [paneId, plan] of specs) {
    if (plan.mcpToken === token) return paneId;
  }
  return null;
}
