/**
 * `VirtualList`'s `followEnd` as rules with no React in them: where the
 * view stands, and whether a change of the rows is followed to the foot.
 * The hook reads the scroll and applies what these answer.
 */

/** How near the foot the view counts as "at the end" — a pixel's
 * rounding, not a band the person must aim for. */
export const END_SLACK_PX = 2;

/** Whether the view stands at the list's foot. */
export function atListFoot(box: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return box.scrollTop + box.clientHeight >= box.scrollHeight - END_SLACK_PX;
}

/**
 * Whether a commit follows the rows to the foot: the list follows, its
 * rows changed, the view stood at the foot just before — and the change
 * is not the person's own (a fold they opened stays where its hold puts
 * it, and the hold is the fold's to keep).
 */
export function followsChange(input: { on: boolean; changed: boolean; wasAtFoot: boolean; eased: boolean }): boolean {
  return input.on && input.changed && input.wasAtFoot && !input.eased;
}

/**
 * Whether the view is held at the foot by intent, after a commit: a
 * follow holds it there — rows guessed short are still being measured
 * toward the foot, and the geometry says "not at the foot" until they
 * are; the person's own fold lets go of it (they are reading what it
 * opened). Otherwise as it was.
 */
export function pinAfterCommit(input: { pinned: boolean; followed: boolean; eased: boolean }): boolean {
  if (input.followed) return true;
  return input.eased ? false : input.pinned;
}

/** After a scroll: the person scrolling up lets go of the foot; the
 * list's own corrections toward it never move up. */
export function pinAfterScroll(input: { pinned: boolean; movedUp: boolean }): boolean {
  return input.movedUp ? false : input.pinned;
}

/** Where the view counts as standing for the next change: held at the
 * foot, or at it as read now. */
export function footAfter(input: { pinned: boolean; readAtFoot: boolean }): boolean {
  return input.pinned || input.readAtFoot;
}
