import { useSyncExternalStore } from "react";
import {
  getRoleCatalog,
  subscribeRoleCatalog,
  type RoleCatalogSnapshot,
} from "./roleCatalogManager";

/**
 * The live role catalog's stored half — a React bridge over the
 * `roleCatalogManager` singleton, the way `useSettings` bridges settings.
 * Read-only by design: writes go through `saveStoredRole` /
 * `removeStoredRole` directly (it isn't React state).
 */
export function useRoleCatalog(): RoleCatalogSnapshot {
  return useSyncExternalStore(subscribeRoleCatalog, getRoleCatalog);
}
