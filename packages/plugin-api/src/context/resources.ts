/**
 * Bundle resources — files a plugin SHIPS (under its `resources/` folder)
 * that must exist on disk at a real path, because they're handed to a
 * spawned CLI's argv or env (e.g. a session-reporter hook script). Web-side
 * assets don't need this; anything a subprocess must open does.
 */
export interface PluginResources {
  /** Absolute filesystem path of `resources/<relative>` inside this plugin's
   * bundle, or `null` when the file is missing (callers degrade — a missing
   * reporter means identity off, never a broken spawn). `relative` is plain
   * `/`-separated segments; no traversal. */
  path(relative: string): Promise<string | null>;
}
