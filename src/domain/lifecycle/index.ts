/**
 * The lifecycle's vocabulary as the page reasons with it: why the machine
 * did not do what was asked, and how its waiting door comes back without an
 * answer. Kinds and data only — the words are presentation's.
 *
 * The machine is Rust's (crates/keepdeck-lifecycle); these types are its
 * wire types seen from the domain, which may not read the IPC layer. The app
 * layer's contract test holds them equal to the generated ones, so neither
 * side can move alone.
 */

/** Why an intent was refused. */
export type Refusal =
  | { kind: "alreadyClosing" }
  | { kind: "busy" }
  | { kind: "notFound" }
  | { kind: "barrierUp" }
  | { kind: "journalUnavailable" }
  | { kind: "journalStuck" }
  | { kind: "locationHeld" }
  | { kind: "targetLeaving" }
  | { kind: "archived" }
  | { kind: "sessionsDown" }
  | { kind: "forkStepExpired" }
  /** A data owner refused its command — its own kind, carried back as given. */
  | { kind: "rejected"; reason: string };

/** The waiting door with no answer to hand back: the machine was not there
 * to ask, or ended before it answered. */
export type NoAnswer = { kind: "unavailable" } | { kind: "unknown" };

/** What the lifecycle has forgotten — the set only grows. A write whose
 * source is in it is refused at its commit; what was accepted before goes
 * with the cleanup of whatever forgot it. */
export interface Forgotten {
  workspaces: string[];
  teams: string[];
  panes: string[];
}

/** Who a write is for: its workspace and, when it has them, its team and
 * pane — as the app knows the writer, never in the writer's own words. */
export interface WriteSource {
  workspace: string;
  team?: string | null;
  pane?: string | null;
}

/** Whether a write from `source` is refused: its workspace, its team or its
 * pane is forgotten. The page's one reading of the set — the same verdict
 * as Rust's `Forgotten::source`, held to it by the contract test. */
export function isForgotten(forgotten: Forgotten, source: WriteSource): boolean {
  return (
    forgotten.workspaces.includes(source.workspace) ||
    (source.team != null && forgotten.teams.includes(source.team)) ||
    (source.pane != null && forgotten.panes.includes(source.pane))
  );
}
