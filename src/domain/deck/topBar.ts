/**
 * How much of the deck bar a group may take.
 *
 * The bar had no ceiling, and two of its groups grew on their own: one usage
 * chip per account-limited agent, one control per plugin that asks for one.
 * A strip that gets worse the more the product is used is not a strip that
 * was arranged badly — it is one that was never told how much room it has.
 *
 * So the rule is stated here, once, as a value rather than as a habit. A
 * habit is what the bar had.
 */

/** Plugin controls that sit in the bar before the rest fold into a menu.
 *
 * Three because that is what the bar can carry beside its own controls
 * without the eye having to count — not because three plugins is a limit on
 * anything. Nothing is lost past it: every contribution still reaches the
 * same `run`, one press further away, and a plugin has three other visible
 * surfaces (a dock tab, an overlay, a command) if a press should be nearer
 * than that. */
export const PLUGIN_ACTION_SLOTS = 3;

/** A group split into what is drawn and what folds away. */
export interface BarGroupFit<T> {
  shown: readonly T[];
  /** Empty when everything fits — the caller draws no overflow control. */
  overflow: readonly T[];
}

/**
 * Fit `items` into `slots` places.
 *
 * The whole rule is the edge: when the items do NOT fit, the control that
 * opens the rest takes a place of its own, so only `slots - 1` stay drawn.
 * Spending all the slots on items and hanging the overflow control off the
 * end is how a ceiling quietly becomes `slots + 1`.
 *
 * Pure.
 */
export function fitBarGroup<T>(
  items: readonly T[],
  /** No default. This is the rule for ANY group, and a group that does not
   *  name its own ceiling would silently inherit the plugin row's — which is
   *  a number about plugins, not about groups. */
  slots: number,
): BarGroupFit<T> {
  // A group with no room at all folds entirely — including the single item
  // that would otherwise look like it fit.
  if (slots <= 0) return { shown: [], overflow: items };
  if (items.length <= slots) return { shown: items, overflow: [] };
  return { shown: items.slice(0, slots - 1), overflow: items.slice(slots - 1) };
}
