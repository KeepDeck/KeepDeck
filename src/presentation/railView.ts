/**
 * What the workspaces rail says, decided apart from the markup that draws it
 * — the [`trayView`] and [`teamCardView`] precedent: one row per workspace,
 * in deck order, carrying the name, the status dot and how much is in it.
 *
 * It lived as an inline `.map` in the application controller: three fields
 * and a fallback, reachable only by rendering the whole app. Nothing tested
 * them, and the rail's number is the only answer the app gives to "how much
 * is in that workspace" — the deck bar dropped its own count precisely
 * because this one already answers. Pure and alone it is a table.
 *
 * The dot arrives already folded rather than folded here: the fold reads
 * live status, which is a subscription's business ([`useWorkspaceFrames`]
 * holds the rail's one subscription), and a projection that took the tracker
 * would carry it into every test that only wanted to know what a row says.
 */
import type { Workspace } from "../domain/deck";
import type { StatusFrame } from "../domain/status";

/** One row of the rail. */
export interface WorkspaceItem {
  id: string;
  name: string;
  agentCount: number;
  /** The workspace's status frame, folded by the domain ladder — the dot
   * paints it verbatim. Absent = the plain gray dot. */
  dot?: StatusFrame;
}

/**
 * Every workspace the deck holds, in its order — a workspace is never
 * omitted, whatever is or is not inside it: the rail is how the person
 * reaches one, so a row that disappears takes the way back with it.
 *
 * A workspace with no folded frame wears `"none"`, the same bare gray dot
 * the frame itself means, so the row's shape does not depend on whether the
 * tracker has heard of it yet.
 */
export function railView(
  workspaces: readonly Workspace[],
  frames: ReadonlyMap<string, StatusFrame>,
): WorkspaceItem[] {
  return workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    agentCount: ws.panes.length,
    dot: frames.get(ws.id) ?? "none",
  }));
}
