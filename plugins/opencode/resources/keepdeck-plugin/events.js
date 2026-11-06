// @ts-check
/**
 * The events this plugin states itself, rather than forwards from opencode's
 * bus — named ONCE for both sides of the process boundary: the plugin in
 * opencode's process posts them, and the normalizer (src/status.ts) reads
 * them. Dependency-free on purpose: the normalizer is browser code, and the
 * plugin's other modules reach for Node.
 *
 * Under `keepdeck.`, so no event of opencode's own can ever share a name.
 */

/** The agent is at its prompt — said as the plugin starts (ready.js). */
export const READY_EVENT = "keepdeck.ready";
