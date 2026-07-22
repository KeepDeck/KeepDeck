import type { TokenCounts } from "@keepdeck/plugin-api";

/** Price tables are immutable ledger inputs. Changing rates means a new
 * version string; already-recorded events keep the version that priced them. */
export const PRICING_VERSION = "openai-standard-2026-07-22";

interface TokenPrice {
  input: number;
  cachedInput: number;
  output: number;
  /** Explicit cache writes are new in GPT-5.6; older automatic cache writes
   * have no separate bucket in Codex telemetry. */
  cacheWrite?: number;
}

/** USD per million tokens, copied from the official OpenAI standard API model
 * pages on the version date. Exact ids only: aliases/snapshots we cannot price
 * confidently stay unavailable rather than inheriting a plausible rate. */
const OPENAI_PRICES: Readonly<Record<string, TokenPrice>> = {
  "gpt-5.6-sol": { input: 5, cachedInput: 0.5, output: 30, cacheWrite: 6.25 },
  "gpt-5.6": { input: 5, cachedInput: 0.5, output: 30, cacheWrite: 6.25 },
  "gpt-5.6-terra": {
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    cacheWrite: 3.125,
  },
  "gpt-5.6-luna": { input: 1, cachedInput: 0.1, output: 6, cacheWrite: 1.25 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
};

export interface CostEstimate {
  usd: number;
  pricingVersion: typeof PRICING_VERSION;
}

/** API-equivalent estimate for telemetry without provider-reported cost.
 * Currently limited to Codex's exact OpenAI model ids. Codex subscription
 * billing may differ; the Stats UI labels this as an estimate, never a charge.
 *
 * OpenAI `input_tokens` includes the cached subset, so fresh input subtracts
 * `cached_input_tokens`. Reasoning is already included in output_tokens and is
 * not charged twice. */
export function estimateUsageCost(
  agent: string,
  model: string | undefined,
  tokens: TokenCounts,
): CostEstimate | null {
  if (agent !== "codex" || !model) return null;
  const modelId = model.trim().split(/\s+/, 1)[0].toLowerCase();
  const price = OPENAI_PRICES[modelId];
  if (!price) return null;

  const cachedInput = Math.max(0, tokens.cacheRead ?? 0);
  const input = Math.max(0, tokens.input ?? 0);
  const freshInput = Math.max(0, input - cachedInput);
  const output = Math.max(0, tokens.output ?? 0);
  const cacheWrite = Math.max(0, tokens.cacheWrite ?? 0);
  if (freshInput + cachedInput + output + cacheWrite === 0) return null;

  const usd =
    (freshInput * price.input +
      cachedInput * price.cachedInput +
      output * price.output +
      cacheWrite * (price.cacheWrite ?? price.input)) /
    1_000_000;
  return {
    usd: Math.round(usd * 1_000_000_000_000) / 1_000_000_000_000,
    pricingVersion: PRICING_VERSION,
  };
}
