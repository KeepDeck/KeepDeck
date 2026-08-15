/**
 * The role catalog's one owner: reads the stored records, writes them, and
 * feeds the DOMAIN the merged result — the pattern `settingsManager` and
 * the skills library already follow: a single stateful owner with
 * subscribe, behind bound verbs.
 *
 * The domain never does IO and the IPC never judges content; this is the
 * seam where the two meet. Every change lands in `configureRoleCatalog`,
 * so planTeam, the briefings and both UIs read the new catalog in the same
 * breath.
 *
 * Three rules this owner holds, each learned the hard way elsewhere:
 *
 * - NEVER WRITE FROM A STATE THAT WAS NOT READ. A failed boot load leaves
 *   the session on the built-ins and refuses saves — the settings manager's
 *   own rule — because a save then would overwrite records this session
 *   never saw, and the UI, showing no "edited" badges, would invite exactly
 *   that.
 * - READS ARE SERIALIZED. An old directory read landing after a newer one
 *   would install over it; the chain makes "later wins" true by
 *   construction.
 * - A LOAD IS NOT A CHANGE. The boot install is the baseline; only a
 *   difference in what the domain reads counts as the catalog CHANGING,
 *   which is what the live-team re-brief subscribes to. Fired on load, it
 *   re-briefed every teamed pane on every app start.
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
  /** Every stored record's id, LOWERCASED (an id is an address, and the
   * catalog compares addresses lowercased) — the unparseable included,
   * because the editor must list a broken record to offer the one thing
   * left to do with it. */
  storedIds: ReadonlySet<string>;
  /** The parseable records by their file's own id — what the merge judges. */
  records: ReadonlyMap<string, unknown>;
  problems: readonly string[];
}

export interface RoleCatalogManager {
  init(): Promise<void>;
  /** Stable between changes (the `useSyncExternalStore` contract). */
  get(): RoleCatalogSnapshot;
  /** The SNAPSHOT moved — every install, the boot load included. */
  subscribe(listener: () => void): () => void;
  /** The catalog CHANGED — what the domain reads differs from what it read
   * before, seen by a session that had a baseline. Never the boot load. */
  onCatalogChanged(listener: () => void): () => void;
  /** Write one record — a custom role, or a built-in's text edit — and
   * re-install the catalog. Refuses before touching the disk when the id
   * fails the domain grammar, or when this session never managed to read
   * the stored records at all. */
  save(id: string, record: StoredRole): Promise<void>;
  /** Delete one record — a custom role's removal, or a built-in's reset to
   * its default texts. Same door for both, because the record IS the
   * difference from the defaults. */
  remove(id: string): Promise<void>;
}

const EMPTY: RoleCatalogSnapshot = {
  storedIds: new Set(),
  records: new Map(),
  problems: [],
};

/** What one directory read established, held so a write whose RE-read fails
 * can still answer honestly: the previous records plus its own durable
 * change. */
interface Held {
  storedIds: Set<string>;
  records: Map<string, unknown>;
  parseProblems: string[];
}

export function createRoleCatalogManager(ports: RoleCatalogPorts): RoleCatalogManager {
  let snapshot = EMPTY;
  let boot: Promise<void> | null = null;
  /** Whether the stored records are KNOWN, and so may be replaced. */
  let writable = false;
  /** Fingerprint of the roles last fed to the domain — null until the
   * first install, which is what makes the boot load a baseline. */
  let installed: string | null = null;
  let held: Held = { storedIds: new Set(), records: new Map(), parseProblems: [] };
  let chain: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const changeListeners = new Set<() => void>();

  /** Merge what is held into the domain and the snapshot, and say so. */
  function apply(): void {
    const merged = mergeRoleCatalog(held.records);
    configureRoleCatalog(merged.roles);
    snapshot = {
      storedIds: new Set(held.storedIds),
      records: new Map(held.records),
      problems: [...held.parseProblems, ...merged.problems],
    };
    const fingerprint = JSON.stringify(merged.roles);
    const changed = installed !== null && installed !== fingerprint;
    installed = fingerprint;
    for (const listener of [...listeners]) listener();
    if (changed) for (const listener of [...changeListeners]) listener();
  }

  function install(files: StoredRoleFile[]): void {
    const next: Held = { storedIds: new Set(), records: new Map(), parseProblems: [] };
    for (const file of files) {
      next.storedIds.add(file.id.trim().toLowerCase());
      // Bytes → value happens HERE, beside the IO; what the value MEANS is
      // the merge's question. A file that is not JSON at all still shows
      // up in `storedIds`, so the editor can offer its deletion.
      try {
        next.records.set(file.id, JSON.parse(file.content));
      } catch {
        next.parseProblems.push(`${file.id}: the file is not valid JSON`);
      }
    }
    held = next;
    apply();
  }

  /** THE directory read, serialized: a read issued earlier can never
   * install over one issued later. Rejections reach the caller and only
   * the caller — the chain itself swallows them, or one failure would
   * skip every later reload's work. */
  function reload(): Promise<void> {
    const step = chain.then(async () => {
      install(await ports.fetchRoleFiles());
    });
    chain = step.catch(() => {});
    return step;
  }

  return {
    init(): Promise<void> {
      boot ??= reload().then(
        () => {
          writable = true;
        },
        (e) => {
          // Never install an empty lie, and never let one be SAVED: with
          // the records unknown, the UI would look like a fresh install —
          // no "edited" badges, no problems — and a save would overwrite
          // files this session never saw. Said in the snapshot, where the
          // settings section renders it, not only in a log.
          log.warn(
            "web:roles",
            `role catalog load failed — running on the built-ins: ${describeError(e)}`,
          );
          snapshot = {
            storedIds: new Set(),
            records: new Map(),
            problems: [
              `the stored role files could not be read (${describeError(e)}) — running on the built-in roles, and NOT saving role edits this session: a save could overwrite records that were never seen. Restart to try again.`,
            ],
          };
          for (const listener of [...listeners]) listener();
        },
      );
      return boot;
    },

    get: () => snapshot,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    onCatalogChanged(listener: () => void): () => void {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
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
      await (boot ?? Promise.resolve());
      if (!writable) {
        throw new Error(
          "the stored role files could not be read when KeepDeck started — saving now could overwrite records this session never saw. Restart to edit roles.",
        );
      }
      await ports.saveRoleFile(trimmed, JSON.stringify(record, null, 2));
      try {
        await reload();
      } catch (e) {
        // The write LANDED; only the re-read failed. Answer from what is
        // known — the previous records plus this durable write — rather
        // than reporting a successful save as failed, or briefing teams
        // from texts the disk no longer holds.
        log.warn(
          "web:roles",
          `role catalog re-read after a save failed — applying the write locally: ${describeError(e)}`,
        );
        for (const key of [...held.records.keys()]) {
          if (key.trim().toLowerCase() === trimmed) held.records.delete(key);
        }
        held.records.set(trimmed, record);
        held.storedIds.add(trimmed);
        apply();
      }
    },

    async remove(id: string): Promise<void> {
      const trimmed = id.trim().toLowerCase();
      await (boot ?? Promise.resolve());
      if (!writable) {
        throw new Error(
          "the stored role files could not be read when KeepDeck started — removing a record now could destroy state this session never saw. Restart to edit roles.",
        );
      }
      await ports.deleteRoleFile(trimmed);
      try {
        await reload();
      } catch (e) {
        log.warn(
          "web:roles",
          `role catalog re-read after a delete failed — applying the delete locally: ${describeError(e)}`,
        );
        for (const key of [...held.records.keys()]) {
          if (key.trim().toLowerCase() === trimmed) held.records.delete(key);
        }
        held.storedIds.delete(trimmed);
        held.parseProblems = held.parseProblems.filter(
          (entry) => !entry.toLowerCase().startsWith(`${trimmed}:`),
        );
        apply();
      }
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
/** The live-team re-brief's feed: catalog CHANGES only, never the boot
 * load — see the manager contract. */
export const subscribeRoleCatalogChanges = (listener: () => void): (() => void) =>
  manager.onCatalogChanged(listener);
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
