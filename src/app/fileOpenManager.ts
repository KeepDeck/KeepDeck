import type { FileOpenHandler, FileOpenRequest } from "@keepdeck/plugin-api";
import type { Contribution } from "../plugins/registries/contributions";
import { describeError } from "../ipc/log";

/**
 * The file-open chain — what a host surface calls when the user asks to open
 * a file (today: ⌘-click on a terminal link). Registered plugin handlers are
 * tried in registration order; the system opener (the OS default app) is the
 * floor that always exists. There is deliberately NO stored preference
 * pointing into the chain: registry membership is the whole truth (a plugin
 * derives its registration from its own settings), so no toggle anywhere can
 * disagree with what a click actually does.
 */

export interface FileOpenOutcome {
  /** Who opened it: a handler's id, or `"system"` for the OS default app. */
  via: string;
  /** Whether any registered handler passed on the request first — a caller
   * can say "opened externally" at the gesture instead of staying silent. */
  declined: boolean;
}

/** Factory over the live handler list + the system floor. The app composition
 * root binds one instance to its own plugin registries. */
export function createFileOpenManager(
  handlers: () => readonly Contribution<FileOpenHandler>[],
  systemOpen: (path: string) => Promise<void>,
  warn: (message: string) => void,
) {
  return {
    async open(request: FileOpenRequest): Promise<FileOpenOutcome> {
      let declined = false;
      for (const { pluginId, entry } of handlers()) {
        try {
          if (await entry.open(request)) return { via: entry.id, declined };
        } catch (error) {
          // A failing handler must not eat the click — logged, then treated
          // as a decline so the chain still lands the file somewhere.
          warn(
            `file-open handler ${pluginId}:${entry.id} failed for ${request.path}: ${describeError(error)}`,
          );
        }
        declined = true;
      }
      await systemOpen(request.path);
      return { via: "system", declined };
    },
  };
}

export type FileOpenManager = ReturnType<typeof createFileOpenManager>;
