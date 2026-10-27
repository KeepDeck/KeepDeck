import type { AgentPresentation } from "@keepdeck/plugin-api";

/**
 * How the host shows claude where claude's own habits matter.
 *
 * - Its terminal titles: claude prefixes some with a decorative or status
 *   glyph, which the pane header does not show — it would read as a
 *   bespoke icon of one agent family. The raw title is kept as sent.
 * - The typed API-error reasons it names in StopFailure, beyond the shared
 *   ones the host already words (rate limit, overload, authentication).
 * - Its series colour in usage charts.
 */
export const claudePresentation: AgentPresentation = {
  oscLeadingGlyphs: ["✦", "✧", "✶", "✳", "✱", "✲", "✷", "✸", "✹", "✺", "✻", "✼", "✽"],
  failureLabels: {
    oauth_org_not_allowed: "Organization not allowed",
    billing_error: "Billing error",
    invalid_request: "Invalid request",
    model_not_found: "Model not found",
    server_error: "Provider error",
    max_output_tokens: "Output limit hit",
  },
  chartColor: "#3987e5",
};
