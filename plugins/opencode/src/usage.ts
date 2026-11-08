import {
  asFiniteNumber,
  asNonEmptyString,
  isJsonRecord,
  type CallTokens,
  type PaneUsage,
  type UsageCall,
  type UsageNormalizer,
} from "@keepdeck/plugin-api";

/**
 * OpenCode usage normalizer — this plugin owns the payload its injected
 * session reporter forwards (`pane-report.js`):
 * `{agent:"opencode", sessionId?, sequence, windowTokens?, contextTokens?, steps?}`.
 *
 * The context is the latest root message's occupancy against its window.
 * The steps are the conversation's model calls, each as opencode recorded
 * it; reading what their counts MEAN happens here. OpenCode exposes NO
 * account rate-limit windows anywhere, so `account` is always null (never
 * an "unavailable" claim — that is a positive claim of absence, which this
 * is not).
 */

/** A count, or 0 for anything that is not one. */
function count(value: unknown): number {
  const counted = asFiniteNumber(value);
  return counted !== undefined && counted > 0 ? counted : 0;
}

/**
 * OpenCode's token usage (`{input, output, reasoning, cache: {read, write}}`)
 * in the canonical classes. OpenCode counts its input fresh and the cache
 * beside it, and its reasoning BESIDE its output — billed as output, so
 * folded into it here, with the reasoning kept as its share.
 */
function opencodeTokens(tokens: unknown): CallTokens {
  const bag = isJsonRecord(tokens) ? tokens : {};
  const cache = isJsonRecord(bag.cache) ? bag.cache : {};
  const reasoning = count(bag.reasoning);
  return {
    input: count(bag.input),
    cacheRead: count(cache.read),
    cacheWrite: count(cache.write),
    output: count(bag.output) + reasoning,
    reasoning,
  };
}

/** One reported step as its call — none without its id, model, provider
 * or time. Its time is its message's creation: a fork keeps that, so the
 * deck drops a fork's copies as older than the fork. */
function opencodeCall(step: unknown): UsageCall | null {
  if (!isJsonRecord(step)) return null;
  const id = asNonEmptyString(step.id);
  const provider = asNonEmptyString(step.providerID);
  const model = asNonEmptyString(step.modelID);
  const at = asFiniteNumber(step.created);
  if (!id || !provider || !model || at === undefined) return null;
  return { id, at, provider, model, tokens: opencodeTokens(step.tokens) };
}

export const normalizeOpencodeUsage: UsageNormalizer = (payload, at) => {
  if (!isJsonRecord(payload)) return null;

  const sessionId = asNonEmptyString(payload.sessionId);
  const sequence = asFiniteNumber(payload.sequence);
  const windowTokens = asFiniteNumber(payload.windowTokens);
  const contextTokens = asFiniteNumber(payload.contextTokens);
  const calls = (Array.isArray(payload.steps) ? payload.steps : [])
    .map(opencodeCall)
    .filter((call): call is UsageCall => call !== null);

  const pane: PaneUsage = {
    agent: "opencode",
    ...(sessionId ? { sessionId } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
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
    reportedAt: at,
  };

  return { account: null, pane, ...(calls.length > 0 ? { calls } : {}) };
};
