// @ts-check
/**
 * Starting the plugin's components, on either opencode generation: each on
 * its own, so one that fails to start takes nothing else down — a KeepDeck
 * problem must never break the user's session.
 */

/** Start every component; one that throws contributes nothing (`{}`).
 * @template T
 * @param {Array<(input: T) => Promise<unknown> | unknown>} starts
 * @param {T} input
 */
export async function startComponents(starts, input) {
  return Promise.all(
    starts.map(async (start) => {
      try {
        return (await start(input)) ?? {};
      } catch {
        return {};
      }
    }),
  );
}
