// @ts-check
/**
 * What only opencode 1.x's plugin client knows how to say — the host adapter
 * the shared components are handed on 1.x. Its 2.x counterpart is
 * opencode-v2.js.
 */

/**
 * Ask a 1.x server whether a session has a parent: `{ parentID }`, or null
 * when it could not tell.
 *
 * The generated client a 1.x plugin is handed RESOLVES with `{error}` rather
 * than throwing — measured on 1.18.15 — so a `catch` alone sees nothing; a
 * missing id in the answer is the same "could not tell".
 *
 * `get` stays bound to its session: the generated client's methods reach
 * their transport through `this` (`Session.get` reads `this._client`), so a
 * bare one throws, every session reads as "unknown", and the deck refuses
 * every mail ask that names one (task-569).
 * @param {unknown} client
 */
export function parentLookupV1(client) {
  if (!client || typeof client !== "object" || !("session" in client)) return undefined;
  const { session } = /** @type {{ session?: { get?: (query: { path: { id: string } }) => Promise<{ error?: unknown, data?: { id?: string, parentID?: string } }> } }} */ (client);
  const get = session?.get?.bind(session);
  if (!get) return undefined;
  /** @param {string} sessionID */
  return async (sessionID) => {
    const found = await get({ path: { id: sessionID } });
    if (!found || found.error || !found.data?.id) return null;
    return { parentID: found.data.parentID };
  };
}
