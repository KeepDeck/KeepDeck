import { createCommandRegistry } from "../domain/commands";

/**
 * The app's one command registry. Module-level like the plugin manager: core
 * features register their commands from the composition root, plugins through
 * their context, and every invoker (voice, MCP, hotkeys) executes against
 * this same instance — one executor, one journal.
 */
export const commands = createCommandRegistry();
