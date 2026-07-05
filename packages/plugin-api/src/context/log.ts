/** The plugin's logger — lines land in keepdeck.log namespaced by plugin id,
 * so a misbehaving plugin is attributable from the log alone. */
export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
