/** Capabilities a view or its nearby hook asks the application to provide.
 * The app binds these once to native IPC; tests supply only the port they use. */

export interface ClipboardPort {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
  readImageTempPath(): Promise<string | null>;
}

export interface ShellPort {
  openUrl(url: string): Promise<void>;
  listApplications(): Promise<string[]>;
}

export interface NotificationPermissionPort {
  notificationPermissionGranted(): Promise<boolean>;
  ensureNotificationPermission(): Promise<boolean>;
}

export interface WindowPointerPort {
  pointerInWindow(): Promise<boolean | null>;
  pointerOnWindow(): Promise<{ x: number; y: number; pressed: boolean } | null>;
}

export interface HostLoggerPort {
  error(target: `web:${string}`, message: string): void;
  warn(target: `web:${string}`, message: string): void;
}
