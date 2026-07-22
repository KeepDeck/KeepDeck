import {
  asFiniteNumber,
  asNonEmptyString,
  collectTokenCounts,
  isJsonRecord,
  type PaneUsage,
  type TokenCounts,
  type UsageNormalizer,
} from "@keepdeck/plugin-api";

/**
 * OpenCode usage normalizer — this plugin owns the payload its injected
 * session reporter forwards on a completed assistant `message.updated`:
 * `{agent:"opencode", sessionId, model, windowTokens?, contextTokens, totals,
 * lastTurn, costUsd}`. OpenCode reports tokens/cost PER MESSAGE, so the
 * reporter already summed the session cumulative (`totals`, `costUsd`) and
 * measured the latest message's occupancy (`contextTokens`); this only maps it
 * to the pane-usage shape. OpenCode exposes NO account rate-limit windows
 * anywhere, so `account` is always null (never an "unavailable" claim — that
 * is a positive claim of absence, which this is not).
 */

/** One opencode token bag ({input, output, reasoning, cacheRead, cacheWrite})
 * → normalized counts. */
function tokens(value: unknown): TokenCounts | undefined {
  if (!isJsonRecord(value)) return undefined;
  return collectTokenCounts({
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    reasoning: value.reasoning,
    total: undefined,
  });
}

export const normalizeOpencodeUsage: UsageNormalizer = (payload, at) => {
  if (!isJsonRecord(payload)) return null;

  const sessionId = asNonEmptyString(payload.sessionId);
  const providerId = asNonEmptyString(payload.providerId);
  const model = asNonEmptyString(payload.model);
  const sequence = asFiniteNumber(payload.sequence);
  const windowTokens = asFiniteNumber(payload.windowTokens);
  const contextTokens = asFiniteNumber(payload.contextTokens);
  const cost = asFiniteNumber(payload.costUsd);
  const totalTokens = tokens(payload.totals);
  const lastTurnTokens = tokens(payload.lastTurn);

  const pane: PaneUsage = {
    agent: "opencode",
    ...(sessionId ? { sessionId } : {}),
    ...(providerId ? { providerId } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(model ? { model } : {}),
    // usedTokens + windowTokens; the host derives the % (and shows tokens
    // without a % when the window size couldn't be resolved).
    ...(contextTokens !== undefined
      ? {
          context: {
            usedTokens: contextTokens,
            ...(windowTokens !== undefined ? { windowTokens } : {}),
          },
        }
      : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(totalTokens ? { totalTokens } : {}),
    ...(lastTurnTokens ? { lastTurnTokens } : {}),
    reportedAt: at,
  };

  return { account: null, pane };
};
