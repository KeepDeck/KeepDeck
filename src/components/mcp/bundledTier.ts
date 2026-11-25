/**
 * How the bundled tier's members become rows the server dialog lists, and
 * what the dialog says of a bundled row.
 *
 * The rows are built from what the service DESCRIBES — the same fact a
 * pane's definition comes from — rather than rebuilt from the transport's
 * status. Their words are presentation's (src/presentation/mcpWords.ts), so
 * the nav line under a row and the panel's hint say the same thing.
 */
import type { BundledMcpDescription } from "../../app/mcp";
import { bundledMcpStateText } from "../../presentation/mcpWords";
import type { McpRow } from "./mcpRows";

/** The tier as rows: each shipped server in the state it is in today.
 * Always present: the tier ships with the app. */
export function bundledMcpRows(tier: readonly BundledMcpDescription[]): McpRow[] {
  return tier.map(({ name, state }) => ({
    scope: { kind: "bundled" },
    name,
    verdict: { kind: "bundled", state },
  }));
}

/** The panel's hint for a bundled row: what its state means, in the words
 * the nav line under it uses. None for a library row, whose panel shows the
 * file itself. */
export function bundledHint(row: McpRow | null | undefined): string | undefined {
  return row?.verdict.kind === "bundled" ? bundledMcpStateText(row.verdict.state) : undefined;
}
