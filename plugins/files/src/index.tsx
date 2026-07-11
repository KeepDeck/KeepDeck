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
import { requestOpen } from "./openRequests";
import { baseName, parentDir } from "./domain/tree";
import { FilesTab } from "./components/FilesTab";

/** The settings key behind "Open terminal file links in KeepDeck". */
export const OPEN_LINKS_KEY = "openFileLinks";

/** The handler the host's file-open chain calls on a terminal link click. */
function peekOpener(ctx: PluginContext): FileOpenHandler {
  return {
    id: "peek",
    label: "KeepDeck file peek",
    async open({ path }) {
      // Previewable = a FILE the fs capability can reach. Probe the parent
      // listing: a scope rejection or a missing entry is a DECLINE (the
      // system opener takes it), never an error. Directories decline too —
      // the peek reads file contents; Finder is the right opener for a dir.
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
      if (!entry || entry.kind === "dir") return false;

      // Park the path BEFORE the reveal: a Files tab that mounts because of
      // the reveal must find the request already waiting.
      requestOpen(path);
      ctx.ui.revealDockTab("files");
      return true;
    },
  };
}

const activate: KeepDeckPlugin["activate"] = async (ctx: PluginContext) => {
  setRuntime(ctx);
  ctx.ui.registerDockTab({ id: "files", label: "Files", Component: FilesTab });
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
  setRuntime(null);
};

const plugin: KeepDeckPlugin = { activate, deactivate };

export default plugin;
