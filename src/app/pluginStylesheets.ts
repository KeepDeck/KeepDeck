/**
 * The CSS half of a built-in plugin's bundle. A plugin that imports CSS in
 * its source gets it emitted as `index.css` next to `index.js` (see
 * scripts/build-plugins.mjs) and flagged in `dist/plugins/index.json`; the
 * production loader links that file here, alongside the module import, so a
 * dock tab never renders unstyled. Dev needs none of this — plugins load
 * from source and Vite injects their styles on import.
 *
 * Trust: only BUILT-IN plugins ever reach this. An external plugin's UI
 * lives in its own iframe document at its own origin and has no channel to
 * link CSS into the host document; the href linked here comes from the app's
 * own bundled index.json — the same file whose `index.js` the module import
 * right next to this call already trusts.
 *
 * The stylesheet's lifetime is the code's lifetime: linked once before the
 * plugin's first activation, never removed — exactly like the ES module
 * itself, which no runtime can unload. A disabled plugin's rules are inert
 * because a built-in styles only class families rooted in its own namespace.
 *
 * Cascade position: appended to the END of <head>, after the app stylesheet
 * bundled at build time — the same "plugin rules come last" order the app's
 * own index.css gave these files before plugins owned them. Between plugins,
 * order follows activation order, which the host keeps deterministic.
 */
export function ensurePluginStylesheet(
  pluginId: string,
  href: string,
  warn: (message: string) => void,
): Promise<void> {
  // Idempotent by plugin id (validated by the manifest's ID_PATTERN — plain
  // lowercase segments, safe inside a quoted attribute selector): a restart
  // or re-enable finds the link already in place and resolves at once.
  if (document.head.querySelector(`link[data-kd-plugin-css="${pluginId}"]`)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.kdPluginCss = pluginId;
    link.onload = () => resolve();
    link.onerror = () => {
      // Missing styles degrade the tab's looks, not its function — log loudly
      // (a 404 here means a broken app build, index.json flagged CSS the
      // bundle doesn't carry) but never fail the activation over it.
      warn(`stylesheet ${href} failed to load`);
      resolve();
    };
    document.head.append(link);
  });
}
