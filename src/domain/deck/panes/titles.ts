/**
 * What a pane is CALLED — on screen while it lives, and in the journal once
 * it is sealed.
 *
 * Its own module because naming and list algebra have nothing in common but
 * the word "pane": adding a fallback, or teaching the cleaner a new glyph,
 * has no business landing in the same file as "may this pane be removed".
 */
import type { Pane } from "./model";

/** What naming a pane needs of its agent: the label for the positional
 * fallback, and the glyphs its CLI decorates terminal titles with. The
 * catalog hands these over as plain values; this module knows no agent. */
export interface TitleAgent {
  id: string;
  label: string;
  titleGlyphs?: readonly string[];
}

/** Display title for the pane at `index`: the manual name wins, then the
 * terminal's auto title, then "<Agent label> N" from the catalog — falling back
 * to the raw agent id while the catalog is still loading ([F11]).
 *
 * Takes the fields it READS, not the catalog entry they come from. Asking
 * for a full `AgentInfo` made every non-UI caller manufacture one — the
 * composition root did it behind a cast, asserting an installed state it had
 * not detected and an empty feature list that does not typecheck — for a
 * function that looks at `id`, `label` and the title glyphs. */
export function paneDisplayTitle(
  pane: Pane,
  index: number,
  agents: readonly TitleAgent[],
): string {
  const agent = agents.find((a) => a.id === pane.agentType);
  return (
    pane.name ??
    cleanAutoTitle(pane.autoTitle, agent?.titleGlyphs) ??
    `${agent?.label ?? pane.agentType} ${index + 1}`
  );
}

/** The title a pane's journal record freezes at seal time: the manual name,
 * else the cleaned terminal auto title — never the derived "Agent N" (that is
 * positional, meaningless once the pane is gone). */
export function paneFrozenTitle(pane: Pane, agents: readonly TitleAgent[]): string | undefined {
  return pane.name ?? cleanAutoTitle(pane.autoTitle, agents.find((a) => a.id === pane.agentType)?.titleGlyphs);
}

/** A terminal title without the decoration the pane's own CLI puts in front
 * of it: one declared glyph followed by whitespace. The raw autoTitle stays
 * as the terminal sent it; only what is shown is cleaned, and another
 * agent's leading glyph — or one with no space after it — is left alone. */
function cleanAutoTitle(title: string | undefined, glyphs: readonly string[] = []): string | undefined {
  // The whitespace after the glyph is read before the end is trimmed, so a
  // title that is only the decoration is no title at all.
  const start = title?.trimStart() ?? "";
  const glyph = glyphs.find((g) => start.startsWith(g) && /\s/.test(start.charAt(g.length)));
  return (glyph ? start.slice(glyph.length) : start).trim() || undefined;
}
