/**
 * The deck's core command set, composed.
 *
 * The commands themselves live one area per module — reading the deck,
 * bringing agents and teams into being, an agent's life, the app's own
 * surfaces, the skills library — because those are five reasons to change,
 * and a single file holding all of them meant every one-argument change was
 * made in a place where twelve unrelated commands were in the way (and left
 * one test double standing in for the whole surface). This file only says
 * which sets exist and hands them the same dependencies.
 */
import type { CommandRegistry } from "../../domain/commands";
import type { CoreCommandDeps } from "./deps";
import { registerLifecycleCommands } from "./lifecycleCommands";
import { registerSkillsCommands } from "./skills";
import { registerSurfaceCommands } from "./surfaceCommands";
import { registerTeamCommands } from "./teamCommands";
import { registerWorkspaceCommands } from "./workspaceCommands";

export type { CoreCommandDeps } from "./deps";

/** Register the core commands; returns the combined unregister. */
export function registerCoreCommands(
  registry: CommandRegistry,
  deps: CoreCommandDeps,
): () => void {
  const disposers = [
    ...registerWorkspaceCommands(registry, deps),
    ...registerTeamCommands(registry, deps),
    ...registerLifecycleCommands(registry, deps),
    ...registerSurfaceCommands(registry, deps),
    // The library's own set lives in its own module, and always has — this
    // split applies its convention to the rest rather than leaving two.
    ...registerSkillsCommands(registry, { deck: deps.deck, skills: deps.skills }),
  ];

  return () => {
    for (const dispose of disposers) dispose();
  };
}
