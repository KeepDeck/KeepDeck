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

/** Long enough for a real label, short enough to stay a label. */
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
  return text.length > MAX_ACTION_TITLE
    ? `${text.slice(0, MAX_ACTION_TITLE - 1).trimEnd()}…`
    : text;
}
