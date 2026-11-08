// @ts-check
/**
 * What a pane's report says, whichever opencode generation it comes from —
 * shared by session-reporter.js (1.x) and session-reporter-v2.js (2.x), which
 * differ only in where they READ the facts. Two copies of the shape would
 * drift per generation, and the deck reads one.
 */

/** Whether this pane was launched with approval prompts skipped — the deck's
 * own choice at spawn, stated here because it cannot be discovered from
 * inside the process. Read once: the mode cannot change under a running CLI. */
export const skipsApprovals = () => process.env.KEEPDECK_OPENCODE_SKIPS_APPROVALS === "1";

/** opencode's token usage (`{input, output, reasoning, cache: {read, write}}`,
 * the same in both generations) as the five counts a report carries. */
/** @typedef {{ input?: number, output?: number, reasoning?: number, cache?: { read?: number, write?: number } }} OpenCodeTokens */
/** @param {OpenCodeTokens | undefined} tokens */
export const tokenCounts = (tokens) => ({
  input: tokens?.input ?? 0,
  output: tokens?.output ?? 0,
  reasoning: tokens?.reasoning ?? 0,
  cacheRead: tokens?.cache?.read ?? 0,
  cacheWrite: tokens?.cache?.write ?? 0,
});

/** The pane's conversation, as `session.bound` states it. A later one is the
 * pane's conversation continuing under a new id: `/new`, or — `switched` — a
 * session the user opened in the TUI (follower.js).
 * @param {string} sessionId
 * @param {boolean} continuing
 * @param {boolean} [switched]
 */
export const boundReport = (sessionId, continuing, switched = false) => ({
  sessionId,
  source: !continuing ? "startup" : switched ? "resume" : "new",
});

/**
 * One model step the pane's conversation made — a call, as opencode records
 * it: its own id, the session it ran in (the conversation or one of its
 * subagents), who served it, when its message was created, and its raw token
 * usage. What the counts MEAN is the plugin normalizer's to say.
 * @typedef {{ id: string, sessionID: string, providerID: string, modelID: string, created: number, tokens: OpenCodeTokens }} Step
 */

/**
 * One `usage.report`: what the pane's context holds now (`lastTurn`, whose
 * total is the context in use) in which conversation, against its window,
 * and the steps the conversation made since the last report.
 * @typedef {{ input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number }} TokenCounts
 * @param {{ sessionId?: string, sequence: number, windowTokens?: number, lastTurn?: TokenCounts, steps?: Step[] }} report
 */
export const usageReport = ({ sessionId, sequence, windowTokens, lastTurn, steps = [] }) => ({
  ...(sessionId ? { sessionId } : {}),
  sequence,
  ...(windowTokens !== undefined ? { windowTokens } : {}),
  ...(lastTurn
    ? { contextTokens: lastTurn.input + lastTurn.output + lastTurn.reasoning + lastTurn.cacheRead + lastTurn.cacheWrite }
    : {}),
  ...(steps.length > 0 ? { steps } : {}),
});

/** How many steps one report carries at most: a resumed conversation's
 * history is reported in reports of this size, not as one huge envelope. */
export const STEPS_PER_REPORT = 200;

/**
 * Context windows by model, from a catalog read once and kept once it
 * answered. `load()` lists `{ providerID, modelID, window }`; each generation
 * supplies its own. Keyed by provider AND model: model ids are not unique
 * across providers, and flattening them picks another provider's limit.
 * Single-flight; a failed load is forgotten so the next report retries.
 * @param {() => Promise<Array<{ providerID: string, modelID: string, window: number | undefined }>>} load
 */
export function createWindowCache(load) {
  /** @type {Map<string, number> | undefined} */
  let windows;
  /** @type {Promise<void> | undefined} */
  let loading;
  /** @param {string} providerID @param {string} modelID */
  const key = (providerID, modelID) => `${providerID}\0${modelID}`;
  /** @param {string | undefined} providerID @param {string | undefined} modelID */
  return async (providerID, modelID) => {
    if (!providerID || !modelID) return undefined;
    if (!windows) {
      loading ??= (async () => {
        /** @type {Map<string, number>} */
        const resolved = new Map();
        for (const entry of await load()) {
          if (typeof entry?.window === "number") {
            resolved.set(key(entry.providerID, entry.modelID), entry.window);
          }
        }
        windows = resolved;
      })();
      try {
        await loading;
      } catch {
        loading = undefined;
        return undefined;
      }
    }
    return windows?.get(key(providerID, modelID));
  };
}
