/**
 * What the bundled tier says about itself in the server dialog, and how the
 * tier's members become rows the dialog lists.
 *
 * The words live here rather than in the dialog so the nav line under a row
 * and the panel's hint say the same thing from one constant, and the rows
 * are built from what the service DESCRIBES — the same fact a pane's
 * definition comes from — rather than rebuilt from the transport's status.
 */
import type { BundledMcpDescription } from "../../app/mcp";
import type { McpRow } from "./mcpRows";

/** The bundled panel's standing framing: what the row is, and that it is
 * not the user's to edit. */
export const BUNDLED_NOTICE =
  "Ships with KeepDeck and updates with it — every agent already has it. Read-only.";

/** A bundled server whose gate is closed: the deck's own server before its
 * socket is confirmed up. Said under the row and in its panel alike. */
export const BUNDLED_PENDING =
  "The deck's socket is not up yet — the invocation fills in once it is.";

/** The tier as rows: each shipped server with the body it would hand a pane
 * today, or pending while it has none. Always present: the tier ships with
 * the app. */
export function bundledMcpRows(tier: readonly BundledMcpDescription[]): McpRow[] {
  return tier.map(({ name, body }) => ({
    scope: { kind: "bundled" },
    name,
    verdict: body ? { kind: "ok", body } : { kind: "pending" },
  }));
}
