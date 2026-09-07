/** Opening the app's own surfaces — settings and usage. */
import {
  type CommandRegistry,
} from "../../domain/commands";

/**
 * The deck's core command set — what any invoker (voice, MCP, hotkeys, a
 * future palette) can do to the deck through the command registry. The plain
 * application controller registers once; accessors read the current store and
 * current UI port for every invocation. This is the STATIC registration
 * lifecycle; feature-gated command sets have their own register/dispose
 * lifecycle. The split is deliberate: a feature toggle must not re-register
 * or tear down the core set.
 */
import type { CoreCommandDeps } from "./deps";
import {
  DIALOG_BUSY_MESSAGE,
} from "./targets";

export function registerSurfaceCommands(
  registry: CommandRegistry,
  deps: CoreCommandDeps,
): (() => void)[] {

  return [
    registry.register({
      id: "settings.open",
      title: "Open settings",
      args: [],
      run: (_args, source) => {
        // A plugin lands on its OWN section; anyone else on the first. The
        // section id mirrors what SettingsDialog builds per plugin.
        const opened = deps.openSettings(
          source.kind === "plugin" ? `plugin:${source.pluginId}` : null,
        );
        if (!opened) throw new Error(DIALOG_BUSY_MESSAGE);
        return { opened: true };
      },
    }),

    registry.register({
      id: "usage.open",
      title: "Open statistics",
      args: [],
      run: () => {
        if (!deps.openUsage()) throw new Error(DIALOG_BUSY_MESSAGE);
        return { opened: true };
      },
    }),
  ];
}
