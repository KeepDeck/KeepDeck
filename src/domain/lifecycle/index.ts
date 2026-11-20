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

export * from "./drafts";
export * from "./facts";
export * from "./ownerRefusals";
export * from "./paneOutcomes";
export * from "./requests";
export * from "./standing";

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
  /** The fork did not finish: no conversation was carried, or it was taken
   * back before its pane ran. */
  | { kind: "forkUnfinished" }
  /** A Close would now do more than its dialog showed: it is asked again. */
  | { kind: "changed" }
  /** A data owner refused its command — its own kind, carried back as given
   * and read by `ownerRefusalOf`. */
  | { kind: "rejected"; why: unknown };

/** What a team allows now, as the machine says it: for each of its own
 * actions, the refusal its intent would meet — null when it would go. */
export interface TeamGates {
  addMember: Refusal | null;
  close: Refusal | null;
  retry: Refusal | null;
}

/** The waiting door with no answer to hand back: the machine was not there
 * to ask, or ended before it answered. */
export type NoAnswer = { kind: "unavailable" } | { kind: "unknown" };

/** What holds a folder, as the machine names it: a team working there, a
 * session running there, a worktree being made there, or one being
 * removed. */
export type Claim =
  | { kind: "team"; team: string }
  | { kind: "session"; session: number }
  /** A launch admitted there, not yet a session. */
  | { kind: "launch"; attempt: number }
  | { kind: "creation"; op: number }
  | { kind: "removal"; op: number };

/** Where the machine has a pane: running as usual, on its way out, being
 * restarted, being suspended, or suspended. */
export type PanePhase = "live" | "leaving" | "restarting" | "suspending" | "suspended";

/** The ids the machine gave what an accepted intent makes. */
export interface Minted {
  workspace: string | null;
  team: string | null;
  panes: string[];
}

/** How an intent the page sent ended: the machine took it on (and named
 * what it makes), refused it, or gave no answer. Whatever it does after
 * reaches the deck as its commands. */
export type IntentOutcome =
  | { kind: "accepted"; op: number; minted: Minted }
  | { kind: "refused"; refusal: Refusal }
  | { kind: "unanswered"; reply: NoAnswer };

/** A folder a close may delete. */
export interface Folder {
  repo: string;
  path: string;
  branch: string | null;
}

/** What a close was consented to: exactly the folders the dialog showed,
 * and the creations still running it named — frozen when it opened. */
export interface Consent {
  /** The agents the dialog showed it ends: a disband or a workspace close
   * that would now end one more is asked again. */
  stops: string[];
  folders: Folder[];
  tickets: number[];
}

/** A place a new team's worktree goes: its folder and its branch. */
export interface Place {
  path: string;
  branch: string;
}

/** Where a new team runs: the workspace root, a folder that exists, or a
 * new worktree — at a place typed by hand, or the machine's next free one. */
export type Site =
  | { kind: "root" }
  | { kind: "existing"; cwd: string }
  | { kind: "new"; place: Place | null; base: string | null };

/** How the deck loaded at boot — what the handshake tells the machine, so
 * it never reconciles against a deck that is not the person's:
 * - `loaded`: read whole, or there was none yet;
 * - `quarantined`: unreadable, set aside, started empty;
 * - `quarantineFailed`: unreadable, and could not be set aside;
 * - `newer`: written by a newer build, so this one only shows;
 * - `readFailed`: could not be read at all. */
export type DeckLoad = "loaded" | "quarantined" | "newer" | "readFailed" | "quarantineFailed";

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
