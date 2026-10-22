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
export const tokenCounts = (tokens) => ({
  input: tokens?.input ?? 0,
  output: tokens?.output ?? 0,
  reasoning: tokens?.reasoning ?? 0,
  cacheRead: tokens?.cache?.read ?? 0,
  cacheWrite: tokens?.cache?.write ?? 0,
});

/** The pane's conversation, as `session.bound` states it. A later one is the
 * pane's conversation continuing under a new id (`/new`). */
export const boundReport = (sessionId, continuing) => ({
  sessionId,
  source: continuing ? "new" : "startup",
});

/**
 * One `usage.report`. `lastTurn` is what the context holds now — its total is
 * the context in use; `totals` and `costUsd` are the conversation's spend.
 */
export const usageReport = ({ sessionId, model, sequence, windowTokens, lastTurn, totals, costUsd }) => {
  const turn = tokenCountsOnly(lastTurn);
  return {
    sessionId,
    ...(model ? { model } : {}),
    sequence,
    ...(windowTokens !== undefined ? { windowTokens } : {}),
    contextTokens: turn.input + turn.output + turn.reasoning + turn.cacheRead + turn.cacheWrite,
    totals: tokenCountsOnly(totals),
    lastTurn: turn,
    costUsd,
  };
};

/** The five counts and nothing else a caller kept beside them. */
const tokenCountsOnly = (counts) => ({
  input: counts.input,
  output: counts.output,
  reasoning: counts.reasoning,
  cacheRead: counts.cacheRead,
  cacheWrite: counts.cacheWrite,
});

/**
 * Context windows by model, from a catalog read once and kept once it
 * answered. `load()` lists `{ providerID, modelID, window }`; each generation
 * supplies its own. Keyed by provider AND model: model ids are not unique
 * across providers, and flattening them picks another provider's limit.
 * Single-flight; a failed load is forgotten so the next report retries.
 */
export function createWindowCache(load) {
  let windows;
  let loading;
  const key = (providerID, modelID) => `${providerID}\0${modelID}`;
  return async (providerID, modelID) => {
    if (!providerID || !modelID) return undefined;
    if (!windows) {
      loading ??= (async () => {
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
    return windows.get(key(providerID, modelID));
  };
}
