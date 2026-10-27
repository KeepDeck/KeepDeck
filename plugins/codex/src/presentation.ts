import type { AgentPresentation } from "@keepdeck/plugin-api";

/**
 * How the host shows codex where codex's own habits matter: the one
 * CodexErrorInfo code the deck would otherwise show raw where it always read
 * as words, and its series colour in usage charts. Its usage limit reaches
 * the host already normalized to the shared `rate_limit` (tail.ts).
 */
export const codexPresentation: AgentPresentation = {
  failureLabels: { model_not_found: "Model not found" },
  chartColor: "#d95926",
};
