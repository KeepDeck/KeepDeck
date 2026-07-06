/**
 * Schema revisions and migrations for every durable JSON document — the one
 * file to touch when a document's shape changes.
 *
 * Two numbers ride every file, answering two DIFFERENT questions:
 *
 * - `version` — the REVISION: which shape wrote the file. Every schema
 *   change bumps it, additive ones included.
 * - `minVersion` — the COMPATIBILITY FLOOR: the oldest revision that can
 *   safely read this shape. Additive changes leave it alone (old readers
 *   just ignore — and preserve — the new fields); only a change to a
 *   field's meaning or form raises it.
 *
 * A reader accepts any file whose `minVersion` is at or below its own
 * revision: older files climb the migration ladder, NEWER files are read
 * as-is (tolerant readers + extras preservation carry the unknown parts
 * through a save round-trip untouched). A floor above the reader's revision
 * parks the session — the one honest option left. This is what makes an
 * additive release safe to run side by side with an older build.
 *
 * Naming: one step per revision hop, `migrate<Doc>FromV<old>toV<new>`.
 * Additive hops are recorded no-ops — the ledger stays honest and a future
 * shape-changing step slots in beside them.
 */

type RawDoc = Record<string, unknown>;
type Migration = (doc: RawDoc) => RawDoc;

/** What reading a document's version markers yields. */
export type MigrationOutcome =
  | { kind: "ok"; doc: RawDoc }
  /** The file needs a reader newer than this build — park, don't touch. */
  | { kind: "incompatible"; version: number; minVersion: number }
  /** No usable version markers, or a hole in the ladder — quarantine. */
  | { kind: "unusable" };

/**
 * deck.json — revision ledger:
 *   1 — workspaces, panes, session bindings, provisioning intents.
 *   2 — + `Workspace.run` (launch presets & setup command).
 *   3 — + `minVersion` compatibility floor, unknown keys preserved.
 *   4 — + `Workspace.plugins` (per-plugin persisted state bag).
 */
export const DECK_STATE_VERSION = 4;
/** Every revision so far is additive over v1 — any reader fits. */
export const DECK_MIN_READER = 1;

/** v1 → v2: `Workspace.run` added — additive, nothing to transform. */
function migrateDeckFromV1toV2(doc: RawDoc): RawDoc {
  return doc;
}

/** v2 → v3: `minVersion` + extras preservation added — additive. */
function migrateDeckFromV2toV3(doc: RawDoc): RawDoc {
  return doc;
}

/** v3 → v4: `Workspace.plugins` added — additive, nothing to transform. */
function migrateDeckFromV3toV4(doc: RawDoc): RawDoc {
  return doc;
}

const DECK_MIGRATIONS: Record<number, Migration> = {
  1: migrateDeckFromV1toV2,
  2: migrateDeckFromV2toV3,
  3: migrateDeckFromV3toV4,
};

/**
 * settings.json — revision ledger:
 *   1 — defaultAgent, scrollback.
 *   2 — + experimentRunPresets.
 *   3 — + `minVersion` compatibility floor.
 *   4 — + plugins (per-plugin enabled flags & values).
 *
 * No ladder: the document is per-key tolerant (independent facts,
 * hand-editable), which IS its migration mechanism while changes stay
 * additive. The first step that changes a field's meaning gets a
 * `migrateSettingsFromV*toV*` here, a ladder like the deck's, and a raised
 * floor.
 */
export const SETTINGS_VERSION = 4;
export const SETTINGS_MIN_READER = 1;

/** The file's effective compatibility floor: what it declares, else its own
 * revision (files from before the floor existed can only promise "a reader
 * exactly as new as me"). */
function floorOf(raw: RawDoc): number | null {
  if (typeof raw.version !== "number") return null;
  return typeof raw.minVersion === "number" ? raw.minVersion : raw.version;
}

/**
 * Resolve a parsed deck document against this build's revision: climb the
 * ladder for older files, pass newer-but-compatible files through as-is
 * (the tolerant reader takes it from there), park what's above our head.
 */
export function migrateDeck(raw: RawDoc): MigrationOutcome {
  const version = raw.version;
  if (typeof version !== "number") return { kind: "unusable" };
  const minVersion = floorOf(raw)!;
  if (minVersion > DECK_STATE_VERSION) {
    return { kind: "incompatible", version, minVersion };
  }
  if (version >= DECK_STATE_VERSION) {
    // Same revision, or a newer one whose floor admits us: read as-is.
    return { kind: "ok", doc: raw };
  }
  let doc = raw;
  for (let v = version; v < DECK_STATE_VERSION; v++) {
    const step = DECK_MIGRATIONS[v];
    if (!step) return { kind: "unusable" };
    doc = { ...step(doc), version: v + 1 };
  }
  return { kind: "ok", doc };
}

/** The settings floor check — the per-key tolerant reader handles the rest.
 * `null` = fine to read; a number = the floor that shuts this build out. */
export function settingsFloorBreach(raw: RawDoc): number | null {
  const minVersion = floorOf(raw);
  if (minVersion === null) return null; // no markers: read tolerantly
  return minVersion > SETTINGS_VERSION ? minVersion : null;
}
