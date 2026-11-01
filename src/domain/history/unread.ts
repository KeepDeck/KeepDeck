import type { AgentSessionFacts } from "@keepdeck/plugin-api";

/**
 * Whether a describe read nothing of its session at all: the file is there,
 * but not as text the plugin can read — codex's compressed rollouts
 * (task-417). Such a stub is still the session. What was read of it before
 * is still true, and an empty reading must not overwrite it.
 *
 * A reading that got part of the way is not this: its facts are what it
 * found, and indexing goes on with them.
 */
export function readNothing(facts: Pick<AgentSessionFacts, "shortfall">): boolean {
  return (facts.shortfall ?? []).some((short) => short.kind === "bytes" && short.readBytes === 0);
}
