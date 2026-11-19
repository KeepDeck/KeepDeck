// @ts-check
/**
 * The agent, model and variant a delivery into an opencode 1.x session must
 * carry, so that a teammate's message runs the way the user's own prompts do.
 *
 * `promptAsync` with no agent picks the config's DEFAULT agent, and with no
 * variant runs the turn without the one the user chose (`max`, say): the
 * server takes the variant from the call, or from the agent's own configured
 * one on that agent's model — never from the session — and writes what it
 * took, "default" for none, into the session (session/prompt.ts:635-689 at
 * v1.19.3). A `noReply` context call is no exception. The TUI then copies
 * that empty variant from the newest user message into its per-model choice
 * on the next session it opens, which is how one delivery reset the effort of
 * every pane after it (task-777).
 *
 * So every call the courier makes repeats the selection the SESSION holds. A
 * 1.x session keeps its agent and model, variant included: the TUI creates it
 * with the composer's choice before the first message exists, and the server
 * rewrites it with every prompt that changes it. Repeating it leaves it where
 * the user put it.
 *
 * The session, not its messages: a brief delivered as the session is created
 * comes before the user's first message has landed, and a pane fed mostly by
 * mail buries the user's last message hundreds of rows back. Measured on the
 * user's store, those two cost 238 deliveries in 30 days.
 *
 * The limit: this is the choice the user last SENT. Picking another model in
 * the composer without sending anything is invisible here — opencode keeps
 * the composer's choice to itself.
 */

/** @typedef {{ agent?: string, model?: { id?: string, providerID?: string, variant?: string } }} SessionInfo */
/** @typedef {{ session?: { get?: (query: { path: { id: string } }) => Promise<{ data?: SessionInfo, error?: unknown }> } }} SelectionClient */

/** The selection fields a prompt body takes, from a session's info. The
 * agent stands on its own — a session can be made with an agent and no model
 * yet — and a variant only with the model it belongs to. "default" is how
 * opencode stores no variant, and is sent as none.
 * @param {SessionInfo | undefined} info
 */
const selectionOf = (info) => {
  const agent = typeof info?.agent === "string" && info.agent ? { agent: info.agent } : {};
  const model = info?.model;
  if (!model?.providerID || !model?.id) return agent;
  const { variant } = model;
  return {
    ...agent,
    model: { providerID: model.providerID, modelID: model.id },
    ...(typeof variant === "string" && variant && variant !== "default" ? { variant } : {}),
  };
};

/**
 * The selection to repeat in a delivery into `sessionID`, or `{}` — a
 * delivery as opencode makes it bare — when the session holds none or cannot
 * be read.
 * @param {SelectionClient | undefined} client
 * @param {string} sessionID
 */
export async function promptSelection(client, sessionID) {
  if (!client?.session?.get) return {};
  try {
    // The client resolves with `{error}` instead of throwing.
    const found = await client.session.get({ path: { id: sessionID } });
    return found?.error ? {} : selectionOf(found?.data);
  } catch {
    return {};
  }
}
