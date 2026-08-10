/**
 * Messages waiting for an opencode pane, in the shape its courier accepts.
 *
 * Every other CLI here answers this question with the JSON its own HOOK
 * prints, because a hook is all it has: a short-lived process whose stdout
 * the CLI reads once. opencode has something better — a plugin that lives
 * inside the agent and holds its server client — so the answer is not hook
 * output at all. It is an instruction to the courier, which then puts the
 * words into the session itself.
 *
 * That is why the payload splits. The two halves are delivered differently
 * and only the deck knows which is which:
 *
 *   context   the standing brief — where this pane stands, who its teammates
 *             are. It must simply BE in the conversation from now on, and
 *             must not start a turn: nothing was said to anybody.
 *   prompt    somebody's words. They are worth a turn, because a message
 *             nobody reads until the next time the user happens to type is
 *             not delivered in any sense that matters.
 *
 * The courier decides HOW each lands (see mail-courier.js) — this file only
 * says which is which, and frames both the same way every CLI frames them.
 */
import {
  frameTeammateMail,
  type DeliverableMail,
  type MailReplyRenderer,
} from "@keepdeck/plugin-api";

/** The one event that can carry an answer. The courier sends it and nothing
 * else does — the session reporter beside it reports facts and asks nothing,
 * which is exactly why the two are separate plugins. */
export const MAIL_ASK_EVENT = "mail.ask";

/** The payload version the courier reads. It is bumped when the SHAPE
 * changes, so a courier from an older KeepDeck (a pane spawned before an
 * update, still running) can tell an answer it cannot read from one that
 * happens to be empty. */
export const MAIL_REPLY_VERSION = 1;

export const renderOpencodeMail: MailReplyRenderer = ({ event, messages }) => {
  // Not our question. Nothing else asks today; refusing by name is what
  // keeps that true — a future reporter armed to ask would otherwise be
  // handed courier instructions it has no idea what to do with.
  if (event.type !== MAIL_ASK_EVENT) return null;
  const standing = messages.filter((mail: DeliverableMail) => mail.standing);
  const traffic = messages.filter((mail: DeliverableMail) => !mail.standing);
  return JSON.stringify({
    v: MAIL_REPLY_VERSION,
    ...(standing.length > 0 ? { context: frameTeammateMail(standing) } : {}),
    ...(traffic.length > 0 ? { prompt: frameTeammateMail(traffic) } : {}),
  });
};
