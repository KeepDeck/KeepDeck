/** A host-managed download. Plugins provide policy as data; the host owns IO. */
export interface DownloadRequest {
  /** Mint a globally unique id for this execution; hosts reject active/recent reuse. */
  id: string;
  source: DownloadSource;
  /** Relative to the calling plugin's private download directory. */
  target: DownloadTarget;
  integrity?: DownloadIntegrity;
}

export interface DownloadSource {
  url: string;
  headers?: Record<string, string>;
}

export type DownloadTarget =
  | { kind: "file"; path: string }
  | {
      kind: "tarGz";
      path: string;
      /** Files that must exist at the published archive root. */
      expectedFiles: string[];
      /** Accept one wrapping directory and publish its contents as the root. */
      stripSingleRoot?: boolean;
    };

export type DownloadIntegrity =
  | { kind: "sha256"; digest: string; bytes?: number }
  | { kind: "minisign"; signature: string; publicKey: string; bytes?: number }
  | { kind: "size"; bytes: number };

export type DownloadPhase =
  | "queued"
  | "downloading"
  | "verifying"
  | "unpacking"
  | "completed"
  | "cancelled"
  | "failed";

export interface DownloadState {
  id: string;
  phase: DownloadPhase;
  received: number;
  total: number | null;
  error?: string;
}

/** Derive presentation progress once, without storing duplicated state. */
export function downloadPercent(
  state: Pick<DownloadState, "received" | "total">,
): number | null {
  if (!state.total || state.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((state.received / state.total) * 100)));
}

export interface PluginDownloads {
  /** Starts immediately; the iterable replays the current state to its reader. */
  start(request: DownloadRequest): AsyncIterable<DownloadState>;
  /** Cancels the job itself. Detaching an iterator only stops observation. */
  cancel(id: string): Promise<void>;
  /** Generic artifact primitives, scoped to the plugin's private directory. */
  exists(target: DownloadTarget): Promise<boolean>;
  remove(target: DownloadTarget): Promise<void>;
  /** Idempotent adoption of a manifest-declared pre-plugin artifact folder. */
  adoptLegacy(request: LegacyDownloadRequest): Promise<void>;
}

export interface LegacyDownloadRequest {
  /** Relative to KeepDeck's historical app-data root; must be capability-declared. */
  source: string;
  /** Relative to this plugin's private download directory. */
  target: string;
  /** Normalize archives historically unpacked into one wrapping folder. */
  stripSingleRoots?: boolean;
}
