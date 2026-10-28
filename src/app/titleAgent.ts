import type { AgentContribution } from "@keepdeck/plugin-api";
import type { TitleAgent } from "../domain/deck";

/** What naming a pane takes from an agent's contribution — the ONE
 * projection both catalogs built from contributions use (the view's
 * AgentInfo and the runtime's labels for mail, MCP and the deck), so the
 * title glyphs have one owner. */
export function titleAgentOf(entry: AgentContribution): TitleAgent {
  return {
    id: entry.id,
    label: entry.label,
    ...(entry.presentation?.oscLeadingGlyphs && { titleGlyphs: entry.presentation.oscLeadingGlyphs }),
  };
}
