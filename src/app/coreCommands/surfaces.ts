import type { CommandRegistry } from "../../domain/commands";
import type { CoreCommandDeps } from ".";

/** The refusal when a command asks for a surface that would stack over one
 * already up. One sentence for both openers, because to the caller they are
 * the same refusal for the same reason. */
const DIALOG_BUSY_MESSAGE =
  "Another dialog is open — close it before opening this one";

/**
 * The surface openers of the core set: settings and statistics. Both ask
 * the same "may another dialog open?" gate the UI does, and refuse with one
 * sentence — to the caller they are the same refusal for the same reason.
 */
export function registerSurfaceCommands(
  registry: CommandRegistry,
  deps: Pick<CoreCommandDeps, "openSettings" | "openUsage">,
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
