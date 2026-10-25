import { useSyncExternalStore } from "react";
import type { StoredRole } from "../domain/mail";
import {
  getRoleCatalog,
  removeStoredRole,
  saveStoredRole,
  subscribeRoleCatalog,
  type RoleCatalogSnapshot,
} from "./roleCatalogManager";

/**
 * The live role catalog's stored half — a React bridge over the
 * `roleCatalogManager` singleton, the way `useSettings` bridges settings.
 * Read-only by design: writes go through `useRoleCatalogWrite` (they
 * aren't React state).
 */
export function useRoleCatalog(): RoleCatalogSnapshot {
  return useSyncExternalStore(subscribeRoleCatalog, getRoleCatalog);
}

/** How a view changes the stored roles: saved under an id, or removed. */
export interface RoleCatalogWrite {
  save(id: string, record: StoredRole): Promise<void>;
  remove(id: string): Promise<void>;
}

const write: RoleCatalogWrite = {
  save: (id, record) => saveStoredRole(id, record),
  remove: (id) => removeStoredRole(id),
};

/** The role catalog's write port. Stable across renders. */
export function useRoleCatalogWrite(): RoleCatalogWrite {
  return write;
}
