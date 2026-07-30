import { createCommandRegistry } from "../domain/commands";

/**
 * The process's one command registry. The runtime-owned application controller
 * registers core features, plugins register through their context, and every
 * invoker (voice, MCP, hotkeys) executes against this same instance.
 */
export const commands = createCommandRegistry();
