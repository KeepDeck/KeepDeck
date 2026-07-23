import type { PluginManifest } from "@keepdeck/plugin-api";

/**
 * The install model — pure data describing what the host knows about a plugin
 * WITHOUT running any of its code. The host projects this over its live
 * entries for the Experiments UI; nothing here touches the registries or the
 * context (that separation is what keeps activation ordering reproducible and
 * this module trivially testable).
 */

/** Where a plugin came from. Built-ins ship with the app and are trusted;
 * external plugins are user-installed and gated by consent — the distinction
 * also fixes activation order (built-ins first, see `orderBySource`). */
export type PluginSource = "builtin" | "external";

/**
 * A plugin's lifecycle position. Kept as a discriminated union (not a flat
 * enum) so the states that carry a WHY — `failed` and `unavailable` — carry
 * it inline: a reason-less failure state is useless in the Experiments UI.
 */
export type PluginStatus =
  /** Installed and eligible, not yet activated. */
  | { kind: "registered" }
  /** `activate` ran to completion; its contributions are live. */
  | { kind: "active" }
  /** Activation was refused or threw; `reason` is a user-facing sentence. */
  | { kind: "failed"; reason: string }
  /** Turned off by the user; never activates until re-enabled. */
  | { kind: "disabled" }
  /** Enabled but its agent's declared binary is not installed on this
   * machine — activation is refused until it appears. Not `failed` (nothing
   * crashed) and not `disabled` (the user never turned it off). */
  | { kind: "unavailable"; reason: string };

/** One installed plugin as the host presents it — manifest, provenance, and
 * current lifecycle position. A snapshot value: the host mints a fresh one on
 * every change so `useSyncExternalStore` sees a new reference. */
export interface InstalledPlugin {
  readonly manifest: PluginManifest;
  readonly source: PluginSource;
  readonly status: PluginStatus;
}

/**
 * Order items built-ins-first, then external, PRESERVING the given order
 * within each group. Activation walks this order and the registries record
 * contributions in insertion order, so the same install set always yields the
 * same contribution order across runs — no accidental dependence on hash-map
 * or Promise-resolution timing. A stable partition (not a comparator sort):
 * `Array.prototype.sort`'s stability is spec-guaranteed today, but expressing
 * intent as two filters removes all doubt and reads plainer.
 */
export function orderBySource<T extends { readonly source: PluginSource }>(
  items: readonly T[],
): T[] {
  const builtins = items.filter((item) => item.source === "builtin");
  const external = items.filter((item) => item.source === "external");
  return [...builtins, ...external];
}
