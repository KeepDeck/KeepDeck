import { useSyncExternalStore } from "react";
import type { AppInfo } from "../ipc/app";
import { readAppInfo } from "./appInfo";
import {
  cancelUpdateDownload,
  checkForUpdatesNow,
  dismissUpdate,
  downloadUpdate,
  getUpdateState,
  restartToUpdate,
  subscribeUpdates,
  type UpdateState,
} from "./updateManager";

export { isFoundUpdate, type FoundUpdateState, type UpdateState } from "./updateManager";

/**
 * The live in-app update state — a React bridge over the `updateManager`
 * singleton. Read-only by design: actions go through `useUpdateActions`
 * (they aren't React state).
 */
export function useUpdate(): UpdateState {
  return useSyncExternalStore(subscribeUpdates, getUpdateState);
}

/** What a view can do about an update — every step an explicit click — and
 * the app's own identity, which it shows beside them. */
export interface UpdateActions {
  check(): Promise<void>;
  download(): Promise<void>;
  cancel(): void;
  dismiss(): Promise<void>;
  restart(): Promise<void>;
  /** The app's name and version, read from the shell once per process. */
  appInfo(): Promise<AppInfo>;
}

const actions: UpdateActions = {
  check: () => checkForUpdatesNow(),
  download: () => downloadUpdate(),
  cancel: () => cancelUpdateDownload(),
  dismiss: () => dismissUpdate(),
  restart: () => restartToUpdate(),
  appInfo: () => readAppInfo(),
};

/** The update port: the actions behind the update state. Stable across
 * renders. */
export function useUpdateActions(): UpdateActions {
  return actions;
}
