/**
 * Why a data owner refused a command of the lifecycle machine: a kind and
 * its data, never words. The machine carries it untouched — into the
 * refused intent's answer, into its journal — and the page says it; so one
 * state reads the same on every surface, and no build's English is kept on
 * disk for another to show.
 */
import { isObjectLike, isOneOf } from "../json";
import type { RoleAdmission, RoleRefusal } from "../mail";

export type OwnerRefusal =
  /** What the command changes is no longer on the deck. */
  | { kind: "gone"; what: "workspace" | "team" | "agent" }
  /** A draft the command carries could not be read. */
  | { kind: "unreadable"; what: "workspace" | "team" | "agent" }
  /** The deck did not take the change its own way: a write that did not land. */
  | { kind: "notTaken"; what: "team" | "agent" | "move" }
  /** The team already holds as many agents as a team may. */
  | { kind: "teamFull" }
  /** The role rule: the role named for the member, and the roles still
   * open on the team when it says them. */
  | { kind: "role"; why: RoleRefusal; role: string; open?: readonly string[] }
  /** The conversation it resumes is open in another agent. */
  | { kind: "sessionHeld" }
  /** A team's worktree settles only on its branch. */
  | { kind: "noBranch" }
  /** The owner carries no such command: KeepDeck asked the wrong one. */
  | { kind: "wrongOwner"; command: string }
  /** Carrying it out failed; what failed is in the log. */
  | { kind: "failed" }
  /** None this build knows: an entry another build journaled. */
  | { kind: "unknown" };

/** The role rule's no, as the owner says it. */
export function roleRefused(refused: Extract<RoleAdmission, { ok: false }>): OwnerRefusal {
  return { kind: "role", why: refused.why, role: refused.role, open: refused.open };
}

const WHATS = ["workspace", "team", "agent"] as const;
const ROLE_REFUSALS: readonly RoleRefusal[] = ["missing", "taken", "unknown", "misfit"];
const text = (value: unknown): value is string => typeof value === "string";
const UNKNOWN: OwnerRefusal = { kind: "unknown" };

/** A refusal as the machine carried it back, read field by field: one this
 * build does not know is `unknown`, never a guess. */
export function ownerRefusalOf(why: unknown): OwnerRefusal {
  if (!isObjectLike(why)) return UNKNOWN;
  switch (why.kind) {
    case "gone":
    case "unreadable":
      return isOneOf(WHATS, why.what) ? { kind: why.kind, what: why.what } : UNKNOWN;
    case "notTaken":
      return isOneOf(["team", "agent", "move"] as const, why.what) ? { kind: "notTaken", what: why.what } : UNKNOWN;
    case "role": {
      if (!isOneOf(ROLE_REFUSALS, why.why) || !text(why.role)) return UNKNOWN;
      const open = why.open;
      if (open === undefined) return { kind: "role", why: why.why, role: why.role };
      return Array.isArray(open) && open.every(text) ? { kind: "role", why: why.why, role: why.role, open } : UNKNOWN;
    }
    case "wrongOwner":
      return text(why.command) ? { kind: "wrongOwner", command: why.command } : UNKNOWN;
    case "teamFull":
    case "sessionHeld":
    case "noBranch":
    case "failed":
      return { kind: why.kind };
    default:
      return UNKNOWN;
  }
}
