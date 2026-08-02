/**
 * A workspace's pane LIST: adding, removing, partitioning, choosing focus —
 * and the title each pane shows.
 *
 * Everything here takes the list (or one pane) and returns a value; nothing
 * reaches for pane lifecycle rules, which is what keeps the reducer's list
 * operations free of "may this pane…" questions.
 */
import { MAX_PANES } from "../layout";
import { paneAgentType } from "./lifecycle";
import type { Pane } from "./index";

/**
 * Append an already-formed `pane` (e.g. one whose worktree is provisioned),
 * unless the fleet is already at [`MAX_PANES`]. Pure: returns the same array
 * (unchanged) when at the cap.
 */
export function appendPane(panes: Pane[], pane: Pane): Pane[] {
  if (panes.length >= MAX_PANES) return panes;
  return [...panes, pane];
}

/** Remove the pane with `id`; a no-op if it isn't present. */
export function removePane(panes: Pane[], id: string): Pane[] {
  return panes.filter((pane) => pane.id !== id);
}

/**
 * Split panes into the ones still on the grid (`live`) and the ones minimized
 * out of it (`minimized`) — the tray/strip minimize styles. A minimized id
 * that no longer matches a pane is simply ignored, so the minimized set
 * self-heals over any pane removal without every removal path having to prune
 * it. Order within each group follows the pane order; when nothing is
 * minimized the SAME `panes` array is returned as `live` (a stable ref for
 * render memoization).
 */
export function partitionPanes(
  panes: Pane[],
  minimized: readonly string[] | undefined,
): { live: Pane[]; minimized: Pane[] } {
  if (!minimized || minimized.length === 0) return { live: panes, minimized: [] };
  const set = new Set(minimized);
  const live: Pane[] = [];
  const out: Pane[] = [];
  for (const pane of panes) (set.has(pane.id) ? out : live).push(pane);
  return { live, minimized: out };
}

/**
 * The pane that should render maximized, or `null` when none does. A workspace
 * with a single pane is never maximized ([U1]: maximize is a no-op on a solo
 * pane — the lone tile already fills the grid), and a `focusedId` that no longer
 * matches any pane (e.g. the maximized pane was just closed) resolves to none.
 */
export function resolveFocus(
  panes: Pane[],
  focusedId: string | undefined,
): string | null {
  if (!focusedId || panes.length <= 1) return null;
  return panes.some((pane) => pane.id === focusedId) ? focusedId : null;
}

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
