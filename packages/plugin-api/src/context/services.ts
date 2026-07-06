/**
 * Platform services. Every call is checked against the manifest's
 * capabilities before it runs (the CapabilityGate): `sessions.spawn` needs
 * an `exec` capability covering the command, `ports.allocate` needs `ports`.
 */
export interface PluginServices {
  readonly sessions: PluginSessions;
  readonly ports: PluginPorts;
  readonly opener: PluginOpener;
}

export interface PluginSessions {
  /** Spawn a PTY session. Closing signals the whole process group. */
  spawn(
    opts: PluginSpawnOptions,
    onEvent: (event: PluginSessionEvent) => void,
  ): Promise<PluginSessionHandle>;
}

export interface PluginSpawnOptions {
  /** Program to run; omit for the user's shell. */
  command?: string | null;
  args?: string[];
  env?: [string, string][];
  cwd?: string;
  cols: number;
  rows: number;
}

export type PluginSessionEvent =
  | { type: "output"; bytes: Uint8Array }
  | { type: "exit"; code: number | null };

export interface PluginSessionHandle {
  readonly id: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

export interface PluginPorts {
  /** Deterministic 10-port block for `key`. */
  allocate(key: string): Promise<number>;
}

/** Open things on the user's machine (capability: `open`) — the default
 * browser for URLs, the default app for file paths. */
export interface PluginOpener {
  openUrl(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
}
