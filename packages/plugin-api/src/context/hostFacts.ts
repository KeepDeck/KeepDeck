/**
 * Read-only facts about the host a plugin may mirror — a NARROW, typed
 * whitelist, grown one field at a time when a real plugin needs one (never
 * ahead). Deliberately not the host's settings object: plugins see named
 * facts, not the host's schema.
 */
export interface PluginHostFacts {
  /** Snapshot of the whitelisted host preferences. */
  settings(): Promise<HostSettingsSnapshot>;
}

export interface HostSettingsSnapshot {
  /** The terminal scrollback the host's own panes use — a log-rendering
   * plugin mirrors it so its terminals feel like the native ones. */
  terminalScrollback: number;
}
