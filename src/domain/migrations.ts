/**
 * Schema revisions and migrations for every durable JSON document — the one
 * file to touch when a document's shape changes. The version field is a
 * REVISION: every schema change bumps it, additive ones included, so the
 * number always says exactly which shape wrote the file.
 *
 * Naming: one step per revision hop, `migrate<Doc>FromV<old>toV<new>`.
 * Additive hops are recorded no-ops — the ledger stays honest and a future
 * shape-changing step slots in beside them.
 */

type RawDoc = Record<string, unknown>;
type Migration = (doc: RawDoc) => RawDoc;

/**
 * deck.json — revision ledger:
 *   1 — workspaces, panes, session bindings, provisioning intents.
 *   2 — + `Workspace.run` (launch presets & setup command).
 */
export const DECK_STATE_VERSION = 2;

/** v1 → v2: `Workspace.run` added — additive, nothing to transform. */
function migrateDeckFromV1toV2(doc: RawDoc): RawDoc {
  return doc;
}

const DECK_MIGRATIONS: Record<number, Migration> = {
  1: migrateDeckFromV1toV2,
};

/**
 * settings.json — revision ledger:
 *   1 — defaultAgent, scrollback.
 *   2 — + experimentRunPresets.
 *
 * No ladder yet: the document is per-key tolerant (independent facts,
 * hand-editable), which IS its migration mechanism while changes stay
 * additive. The first step that changes a field's meaning gets a
 * `migrateSettingsFromV*toV*` here and a ladder like the deck's.
 */
export const SETTINGS_VERSION = 2;

/** Upgrade a parsed deck document to the current revision, one hop at a
 * time. `null` when the file comes from a NEWER build (this build can't
 * know that shape — quarantine beats silently misreading it), from below
 * the ladder's floor, or carries no numeric version at all. */
export function migrateDeck(raw: RawDoc): RawDoc | null {
  if (typeof raw.version !== "number") return null;
  let doc = raw;
  for (let v = raw.version; v < DECK_STATE_VERSION; v++) {
    const step = DECK_MIGRATIONS[v];
    if (!step) return null;
    doc = { ...step(doc), version: v + 1 };
  }
  return doc.version === DECK_STATE_VERSION ? doc : null;
}
