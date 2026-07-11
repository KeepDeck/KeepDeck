/**
 * The Files built-in plugin — a dock tab that browses the workspace file tree
 * and previews file contents over the plugin API's `fs` service, plus a
 * file-open handler that routes the host's terminal file links into that
 * preview. `activate` stashes the context (the host-mounted tab tree reads it
 * back through the runtime holder), registers the tab and the settings
 * section, and DERIVES the handler registration from the plugin's own
 * "openFileLinks" setting — registered while on, disposed when off — so the
 * visible toggle and the click behavior are projections of one state and can
 * never disagree.
 */
import type {
  Disposable,
  FileOpenHandler,
  KeepDeckPlugin,
  PluginContext,
} from "@keepdeck/plugin-api";
import { setRuntime } from "./runtime";
import {
  hasOpenRequestConsumer,
  requestOpen,
  takeOpenRequest,
} from "./openRequests";
import { baseName, parentDir } from "./domain/tree";
import { FilesTab } from "./components/FilesTab";
import { FilesOverlay } from "./components/FilesOverlay";

/** The settings key behind "Open terminal file links in KeepDeck". */
export const OPEN_LINKS_KEY = "openFileLinks";

/** The handler the host's file-open chain calls on a terminal link click. */
function peekOpener(ctx: PluginContext): FileOpenHandler {
  return {
    id: "peek",
    label: "KeepDeck file peek",
    async open({ path }) {
      // Previewable = a PLAIN FILE the fs capability can reach. Probe the
      // parent listing: a scope rejection or a missing entry is a DECLINE
      // (the system opener takes it), never an error. Directories and
      // symlinks decline too — the peek reads plain file contents, a symlink
      // may point at a directory or clean out of the fs scope (the backend
      // refuses to follow it there), and the system opener handles both.
      const parent = parentDir(path);
      const name = baseName(path);
      if (!parent || !name) return false;
      let entries;
      try {
        entries = await ctx.services.fs.readDir(parent);
      } catch {
        return false;
      }
      const entry = entries.find((e) => e.name === name);
      if (!entry || entry.kind !== "file") return false;

      // "Handled" must be TRUE: without a live consumer — the plugin was
      // disabled while the probe was in flight, or the overlay crashed — an
      // accepted click would land nowhere. Decline instead; the chain's
      // system floor takes it. Same tick as the park, so no request races
      // past the check.
      if (!hasOpenRequestConsumer()) return false;

      // The resident FilesOverlay consumes this — no dock involvement at
      // all, so a terminal link never rearranges the user's layout.
      requestOpen({ path });
      return true;
    },
  };
}

const activate: KeepDeckPlugin["activate"] = async (ctx: PluginContext) => {
  setRuntime(ctx);
  ctx.ui.registerDockTab({ id: "files", label: "Files", Component: FilesTab });
  // The viewer is a RESIDENT overlay, not part of the tab: the tree's own
  // opens need it with the dock in any state, and terminal links need it
  // with the dock closed. Registered unconditionally — it renders nothing
  // until a request arrives.
  ctx.ui.registerOverlay({ id: "viewer", Component: FilesOverlay });
  ctx.settings.registerSection({
    label: "Files",
    fields: [
      {
        kind: "boolean",
        key: OPEN_LINKS_KEY,
        label: "Open terminal file links in KeepDeck",
        default: true,
      },
    ],
  });

  // The derived registration: in the host's file-open chain exactly while the
  // toggle is on. `dispose` unregisters via the context's own tracking, so a
  // later deactivation can't double-dispose.
  let opener: Disposable | null = null;
  const apply = (values: Record<string, unknown>) => {
    const on = values[OPEN_LINKS_KEY] !== false;
    if (on && !opener) {
      opener = ctx.openers.register(peekOpener(ctx));
    } else if (!on && opener) {
      opener.dispose();
      opener = null;
    }
  };
  apply(await ctx.settings.read());
  ctx.settings.onChange(apply);
};

const deactivate: KeepDeckPlugin["deactivate"] = () => {
  // Drain the one-slot bus: a request parked in this lifetime must never
  // replay into the NEXT activation's overlay as a stale peek.
  takeOpenRequest();
  setRuntime(null);
};

const plugin: KeepDeckPlugin = { activate, deactivate };

export default plugin;
