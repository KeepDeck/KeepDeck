/**
 * The agent, model and variant a delivery into an opencode 1.x session must
 * carry, so that a teammate's message runs the way the user's own last prompt
 * did.
 *
 * `promptAsync` with no agent picks the config's DEFAULT agent, and with no
 * variant drops the one the user chose (`max`, say) — measured on 1.19.3,
 * task-446. A `noReply` context call is no exception: it, too, writes a user
 * message and sets the session's agent and model (session/prompt.ts:635-688).
 * So every call the courier makes into a session repeats the selection of the
 * newest message the USER sent there.
 *
 * Which message is the user's is decided per PART, not per message. KeepDeck
 * puts its own messages into the session too — the brief as synthetic
 * context, a teammate's words as a prompt, and mail riding along INSIDE the
 * user's own message — while a user's message can carry synthetic parts of
 * its own (attached files). A message is the user's when at least one of its
 * text parts is neither synthetic nor KeepDeck's mail. That also leaves out
 * `!shell` (its only text part is synthetic).
 *
 * The limit: this is the selection of the last prompt the user SENT. Picking
 * another model in the composer without sending anything is invisible here —
 * opencode keeps the composer's choice to itself.
 */

/** How every message KeepDeck writes into a session begins — the opening line
 * of `frameTeammateMail` (packages/plugin-api/src/context/status.ts). This
 * file is shipped into the user's opencode and cannot import it. */
export const MAIL_FRAME = "<teammate-message>";

/** How far back to look: a short window first, a wider one if a long
 * KeepDeck exchange buried the user's last message. Never the whole session —
 * an unbounded read carries every tool output it ever produced. */
const WINDOWS = [20, 200];

const isUsersText = (part) =>
  part?.type === "text" &&
  !part.synthetic &&
  typeof part.text === "string" &&
  !part.text.startsWith(MAIL_FRAME);

const isUsersMessage = (row) =>
  row?.info?.role === "user" && Array.isArray(row.parts) && row.parts.some(isUsersText);

/** The selection fields a prompt body takes, from a user message's info. */
const selectionOf = (info) => {
  const model = info?.model;
  if (!model?.providerID || !model?.modelID) return {};
  return {
    ...(typeof info.agent === "string" && info.agent ? { agent: info.agent } : {}),
    model: { providerID: model.providerID, modelID: model.modelID },
    ...(typeof model.variant === "string" && model.variant ? { variant: model.variant } : {}),
  };
};

/**
 * The selection to repeat in a delivery into `sessionID`, or `{}` — today's
 * behaviour — when the user has sent nothing there or the session cannot be
 * read. Read it BEFORE injecting anything: after, the newest message is ours.
 */
export async function promptSelection(client, sessionID) {
  if (!client?.session?.messages) return {};
  for (const limit of WINDOWS) {
    let rows;
    try {
      const result = await client.session.messages({ path: { id: sessionID }, query: { limit } });
      rows = result?.data;
    } catch {
      return {};
    }
    // The client resolves with `{error}` instead of throwing.
    if (!Array.isArray(rows)) return {};
    // Newest last: the server returns the newest `limit` in chronological order.
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (isUsersMessage(rows[i])) return selectionOf(rows[i].info);
    }
    // Fewer rows than asked for: that was the whole session.
    if (rows.length < limit) return {};
  }
  return {};
}
