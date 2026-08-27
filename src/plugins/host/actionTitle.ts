/**
 * What a contributed action is allowed to call itself.
 *
 * The title is the only text the host has for a plugin's button: it is the
 * accessible name, the tooltip, and — with no icon — the letter drawn ON the
 * button. It arrives from someone else's code and was taken on trust.
 *
 * Two ways that goes wrong, and they want different answers:
 *
 *   EMPTY is an authoring mistake, so it throws, like every other thing the
 *     manifest gate refuses. A blank title makes a button with no name, no
 *     tooltip and no glyph — and now that the bar has a ceiling, that nameless
 *     button also takes one of the three places and folds SOMEONE ELSE's
 *     working control into the overflow menu.
 *
 *   TOO LONG is not a mistake, just a plugin that does not know how much room
 *     it is in, so it is trimmed rather than refused. A menu is as wide as
 *     what is in it, which is right for labels and wrong for paragraphs.
 *
 * Enforced here, at registration, rather than where the bar draws: the RPC
 * bridge for external plugins calls this same context, so one gate covers
 * built-in and external alike — and it covers every surface an action reaches,
 * including ones not written yet.
 */

/** Long enough for a real label, short enough to stay a label.
 *
 *  Counted in CHARACTERS the reader sees, not in the units a string happens to
 *  be stored in. This is a limit on "label, not paragraph" — it is not derived
 *  from the bar's width, and the real ceiling on how many controls fit is
 *  `fitBarGroup`'s. If it ever becomes a number of pixels, it belongs to the
 *  bar and not here. */
export const MAX_ACTION_TITLE = 60;

export function actionTitle(
  kind: string,
  id: string,
  title: unknown,
): string {
  const text = typeof title === "string" ? title.trim() : "";
  if (text === "") {
    throw new Error(`contribution has no title: ${kind} "${id}"`);
  }
  // By code point, not by `slice`. A JS string is UTF-16, so an emoji or a
  // flag is TWO units and a cut at unit 59 can land between its halves —
  // leaving a lone surrogate that the bar draws as a replacement glyph, right
  // where the title was trimmed to look tidy.
  const chars = Array.from(text);
  if (chars.length <= MAX_ACTION_TITLE) return text;
  return `${chars.slice(0, MAX_ACTION_TITLE - 1).join("").trimEnd()}…`;
}
