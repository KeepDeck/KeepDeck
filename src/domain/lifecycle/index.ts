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
