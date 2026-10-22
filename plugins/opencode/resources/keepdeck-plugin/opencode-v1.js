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
 */
export function parentLookupV1(client) {
  if (!client?.session?.get) return undefined;
  return async (sessionID) => {
    const found = await client.session.get({ path: { id: sessionID } });
    if (!found || found.error || !found.data?.id) return null;
    return { parentID: found.data.parentID };
  };
}
