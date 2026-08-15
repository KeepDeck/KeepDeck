/**
 * The role catalog's one owner: reads the stored records, writes them, and
 * feeds the DOMAIN the merged result — the pattern `settingsManager` and
 * the skills library already follow: a single stateful owner with
 * subscribe, behind bound verbs.
 *
 * The domain never does IO and the IPC never judges content; this is the
 * seam where the two meet. Every change lands in `configureRoleCatalog`,
 * so planTeam, the briefings and both UIs read the new catalog in the same
 * breath — and subscribers (the settings section, the re-brief trigger)
 * hear about it once per change.
 *
 * After every write the catalog is RE-READ from disk rather than patched
 * in memory: the disk is the one source of truth, and a cache that edits
 * itself is a second one waiting to disagree.
 */
import {
  configureRoleCatalog,
  mergeRoleCatalog,
  roleIdProblem,
  type StoredRole,
} from "../domain/mail";
import {
  deleteRoleFile,
  fetchRoleFiles,
  saveRoleFile,
  type StoredRoleFile,
} from "../ipc/roles";
import { describeError, log } from "../ipc/log";

export interface RoleCatalogPorts {
  fetchRoleFiles(): Promise<StoredRoleFile[]>;
  saveRoleFile(id: string, content: string): Promise<void>;
  deleteRoleFile(id: string): Promise<void>;
}

/** What the settings surface renders: which records exist, what they hold,
 * and every refusal the load produced — the person reading `problems` is
 * the one who can fix the file. */
export interface RoleCatalogSnapshot {
  /** Every stored record's id, the unparseable included — the editor must
   * list a broken record to offer the one thing left to do with it. */
  storedIds: ReadonlySet<string>;
  /** The parseable records by id — what the editor loads into its form. */
  records: ReadonlyMap<string, unknown>;
  problems: readonly string[];
}

export interface RoleCatalogManager {
  init(): Promise<void>;
  /** Stable between changes (the `useSyncExternalStore` contract). */
  get(): RoleCatalogSnapshot;
  subscribe(listener: () => void): () => void;
  /** Write one record — a custom role, or a built-in's text edit — and
   * re-install the catalog. Throws what the disk threw, and refuses an id
   * the domain grammar refuses before touching the disk at all. */
  save(id: string, record: StoredRole): Promise<void>;
  /** Delete one record — a custom role's removal, or a built-in's reset
   * to its default texts. Same door for both, because the record IS the
   * difference from the defaults. */
  remove(id: string): Promise<void>;
}

const EMPTY: RoleCatalogSnapshot = {
  storedIds: new Set(),
  records: new Map(),
  problems: [],
};

export function createRoleCatalogManager(ports: RoleCatalogPorts): RoleCatalogManager {
  let snapshot = EMPTY;
  let boot: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function install(files: StoredRoleFile[]): void {
    const storedIds = new Set<string>();
    const records = new Map<string, unknown>();
    const parseProblems: string[] = [];
    for (const file of files) {
      storedIds.add(file.id);
      // Bytes → value happens HERE, beside the IO; what the value MEANS is
      // the merge's question. A file that is not JSON at all still shows
      // up in `storedIds`, so the editor can offer its deletion.
      try {
        records.set(file.id, JSON.parse(file.content));
      } catch {
        parseProblems.push(`${file.id}: the file is not valid JSON`);
      }
    }
    const merged = mergeRoleCatalog(records);
    configureRoleCatalog(merged.roles);
    snapshot = { storedIds, records, problems: [...parseProblems, ...merged.problems] };
    for (const listener of [...listeners]) listener();
  }

  async function reload(): Promise<void> {
    install(await ports.fetchRoleFiles());
  }

  return {
    init(): Promise<void> {
      // A failed read keeps the built-ins: never install an empty lie, and
      // never block the app on the roles folder. Later saves re-read.
      boot ??= reload().catch((e) => {
        log.warn(
          "web:roles",
          `role catalog load failed — running on the built-ins: ${describeError(e)}`,
        );
      });
      return boot;
    },

    get: () => snapshot,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async save(id: string, record: StoredRole): Promise<void> {
      const trimmed = id.trim().toLowerCase();
      // The domain's grammar, asked before the disk is touched. Built-in
      // ids pass it by construction, so one check covers edits and
      // creations alike — and the form upstream refuses in the same words,
      // because they come from the same function.
      const problem = roleIdProblem(trimmed);
      if (problem) throw new Error(problem);
      await ports.saveRoleFile(trimmed, JSON.stringify(record, null, 2));
      await reload();
    },

    async remove(id: string): Promise<void> {
      await ports.deleteRoleFile(id.trim().toLowerCase());
      await reload();
    },
  };
}

/** The app's one catalog owner, wired to the real IPC. The named exports
 * are its bound verbs — what main.tsx, the hook and the settings section
 * consume. */
let manager = createRoleCatalogManager({
  fetchRoleFiles,
  saveRoleFile,
  deleteRoleFile,
});

export const initRoleCatalog = (): Promise<void> => manager.init();
export const getRoleCatalog = (): RoleCatalogSnapshot => manager.get();
export const subscribeRoleCatalog = (listener: () => void): (() => void) =>
  manager.subscribe(listener);
export const saveStoredRole = (id: string, record: StoredRole): Promise<void> =>
  manager.save(id, record);
export const removeStoredRole = (id: string): Promise<void> => manager.remove(id);

/** Fresh manager for a test host — and the domain slot back to the
 * built-ins, because the old manager configured it. */
export function resetRoleCatalogManager(): void {
  manager = createRoleCatalogManager({
    fetchRoleFiles,
    saveRoleFile,
    deleteRoleFile,
  });
  configureRoleCatalog(null);
}
