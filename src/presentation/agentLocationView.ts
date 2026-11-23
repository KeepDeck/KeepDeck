/**
 * What the agent dialog's location field shows of a folder, from what the
 * lifecycle machine says holds it.
 */
import type { DirectoryState } from "../domain/agents";
import type { Claim } from "../domain/lifecycle";

/** A folder as the location field reads the machine's claims on it: held
 * while a worktree is made or removed there — that outranks a team on it —
 * worked in while a team is, free otherwise. A session running there holds
 * nothing the field asks about. */
export function directoryStateOf(claims: readonly Claim[]): DirectoryState {
  if (claims.some((claim) => claim.kind === "creation" || claim.kind === "removal")) return "held";
  return claims.some((claim) => claim.kind === "team") ? "worked-in" : "free";
}
