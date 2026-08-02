/**
 * What a pane is CALLED — on screen while it lives, and in the journal once
 * it is sealed.
 *
 * Its own module because naming and list algebra have nothing in common but
 * the word "pane": adding a fallback, or teaching the cleaner a new glyph,
 * has no business landing in the same file as "may this pane be removed".
 */
import { paneAgentType } from "./lifecycle";
import type { Pane } from "./model";

/** Display title for the pane at `index`: the manual name wins, then the
 * terminal's auto title, then "<Agent label> N" from the catalog — falling back
 * to the raw agent id while the catalog is still loading ([F11]).
 *
 * Takes the two fields it READS, not the catalog entry they come from. Asking
 * for a full `AgentInfo` made every non-UI caller manufacture one — the
 * composition root did it behind a cast, asserting an installed state it had
 * not detected and an empty feature list that does not typecheck — for a
 * function that looks at `id` and `label`. */
export function paneDisplayTitle(
  pane: Pane,
  index: number,
  agents: readonly { id: string; label: string }[],
): string {
  const agentType = paneAgentType(pane);
  const label = agents.find((a) => a.id === agentType)?.label ?? agentType;
  return pane.name ?? cleanPaneAutoTitle(pane.autoTitle) ?? `${label} ${index + 1}`;
}

/** The title a pane's journal record freezes at seal time: the manual name,
 * else the cleaned terminal auto title — never the derived "Agent N" (that is
 * positional, meaningless once the pane is gone). */
export function paneFrozenTitle(pane: Pane): string | undefined {
  return pane.name ?? cleanPaneAutoTitle(pane.autoTitle);
}

/** Claude Code prefixes some OSC titles with a decorative/status glyph. Keep the
 * raw autoTitle for persistence, but do not make one agent family look like it
 * has a bespoke pane-header icon. */
function cleanPaneAutoTitle(title: string | undefined): string | undefined {
  const cleaned = title?.replace(/^[✦✧✶✳✱✲✷✸✹✺✻✼✽]\s+/, "").trim();
  return cleaned || undefined;
}
