import { createCommandRegistry } from "../domain/commands";
import { describeError, log } from "../ipc/log";

/**
 * The process's one command registry. The runtime-owned application controller
 * registers core features, plugins register through their context, and every
 * invoker — voice, hotkeys, and whatever external transport eventually lands —
 * executes against this same instance.
 */
export const commands = createCommandRegistry({
  onListenerError: (error) =>
    log.warn(
      "web:commands",
      `onDidExecute listener failed: ${describeError(error)}`,
    ),
});
