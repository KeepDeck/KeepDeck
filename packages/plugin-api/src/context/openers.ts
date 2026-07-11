import type { Disposable } from "./disposable.ts";

/**
 * File-open handlers — how a plugin claims the host's "open this file"
 * gestures (today: ⌘-click on a file link in a terminal). The host keeps a
 * chain: registered handlers in registration order, then its own system
 * opener (the OS default app) as the floor that always exists. There is no
 * stored preference pointing at a handler — whether a handler is in the
 * chain IS the whole truth, so a plugin should derive its registration from
 * its own settings (register while "on", dispose when "off") and the visible
 * toggle can never disagree with the behavior.
 */
export interface FileOpenRequest {
  /** Absolute file path — the host already resolved relative links against
   * the surface's working directory. */
  path: string;
}

export interface FileOpenHandler {
  /** Identity within the owning plugin — must match an id declared in the
   * manifest's `contributes.fileOpeners`. */
  id: string;
  /** Human name, for logs and any future chooser UI. */
  label: string;
  /**
   * Try to open the file. Resolve `true` when handled; `false` to DECLINE —
   * out of the plugin's reach (fs scope) or not previewable — and let the
   * host fall through to the next handler and finally the system opener.
   * A rejection is a real failure: logged, then treated as a decline so the
   * user's click still lands somewhere.
   */
  open(request: FileOpenRequest): Promise<boolean>;
}

export interface PluginFileOpeners {
  /** Put this handler into the host's file-open chain. Disposing removes it;
   * deactivation disposes automatically like every registration. */
  register(handler: FileOpenHandler): Disposable;
}
