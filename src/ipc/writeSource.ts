import type { WriteSource } from "../domain/lifecycle";

/** Who a write is for, as Rust's `forgotten::Source` reads it off the wire. */
export interface SourceWire {
  workspaceId: string;
  team: string | null;
  pane: string | null;
}

/** A write's source in the wire's spelling — the one place it is spelled. */
export function sourceWire(source: WriteSource): SourceWire {
  return { workspaceId: source.workspace, team: source.team ?? null, pane: source.pane ?? null };
}

/** A library write's writer: the agent writing, as the store's gate reads
 * it — none for the person at the UI. */
export function writerWire(writer: WriteSource | null): SourceWire | null {
  return writer ? sourceWire(writer) : null;
}
