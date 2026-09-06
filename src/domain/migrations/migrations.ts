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

import { isRecord } from "../json";

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
 *   5 — `Workspace.run` retired: its `setup` moves to the core
 *       `Workspace.setup` field (provisioning owns it, not a plugin), its
 *       `presets` move to `plugins["keepdeck.run"]`; `run` itself is dropped.
 *       (`Workspace.setup` has since been retired in turn — nothing runs it —
 *       and the key now rides along in `extras`. The hop below is unchanged:
 *       a ledger records what a document went through, not what the current
 *       build still reads.)
 *   6 — + `PaneProvisioning.base` (the picked base branch a Retry recreates
 *       the worktree from).
 *   7 — + `Pane.yolo` (the agent runs with permission prompts disabled).
 *   8 — + `Pane.remoteEndpoint` (the agent runs against a remote
 *       native-server endpoint).
 *   9 — + `Pane.idle` carrying the `suspended` reason (a pane the user
 *       suspended stays suspended across a restart instead of waking).
 *  10 — + `Pane.team` (which team the agent belongs to and under what role,
 *       so messages can be addressed by role instead of by pane).
 *  11 — a team is an OBJECT: + `Workspace.teams` (id, name, and the one
 *       directory the team runs in, or the create heading for one), and
 *       `Pane.team` names it by ID — `{teamId, role}` in place of
 *       `{name, role}`. The floor rises to 11 with it: a v10 reader takes
 *       `{teamId, role}` for a half-written `{name, role}` and reads every
 *       membership as none, then SAVES — silently dismissing every team.
 */
export const DECK_STATE_VERSION = 11;
/** The oldest reader that can still make sense of a current document. It was
 * held at 1 while every change was additive (v1→v4, v6→v10) or moved data an
 * old reader would merely lose rather than misread (v5's `run` retirement).
 * v11 changes what `Pane.team` MEANS, which is the one kind of change that
 * raises the floor: a v10 build reading a v11 file would misinterpret data it
 * still consumes, and its next save would write the misreading back. Parking
 * is the honest option left. */
export const DECK_MIN_READER = 11;

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

/** The Run plugin's storage id — the destination for a migrated `run.presets`. */
const RUN_PLUGIN_ID = "keepdeck.run";

/**
 * v4 → v5: `Workspace.run` is retired. Its two parts move to where they
 * belonged at the time — `setup` onto the workspace itself, `presets` into the
 * Run plugin's own slot — and `run` is deleted. `setup` has since been retired
 * as a field too, so it lands in the workspace's `extras` on load rather than
 * in a field; the hop still writes it, because the user's value is theirs and
 * a migration that dropped it would be a migration that lost data. A workspace without a `run`
 * object passes through untouched. A `plugins["keepdeck.run"]` slot already
 * present (not expected before this hop) loses to the migrated data: the
 * migrated presets are the source of truth and the old slot's content is not
 * preserved anywhere.
 */
function migrateDeckFromV4toV5(doc: RawDoc): RawDoc {
  const workspaces = doc.workspaces;
  if (!Array.isArray(workspaces)) return doc;
  return { ...doc, workspaces: workspaces.map(migrateWorkspaceRunToV5) };
}

function migrateWorkspaceRunToV5(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { run, ...rest } = value;
  if (!isRecord(run)) return value; // no run object: untouched

  const next: RawDoc = { ...rest };
  if (typeof run.setup === "string" && run.setup.trim() !== "") {
    next.setup = run.setup;
  }
  if (Array.isArray(run.presets) && run.presets.length > 0) {
    const plugins = isRecord(rest.plugins) ? { ...rest.plugins } : {};
    next.plugins = { ...plugins, [RUN_PLUGIN_ID]: { presets: run.presets } };
  }
  return next;
}

/** v5 → v6: `PaneProvisioning.base` added — additive, nothing to transform. */
function migrateDeckFromV5toV6(doc: RawDoc): RawDoc {
  return doc;
}

/** v6 → v7: `Pane.yolo` added — additive, nothing to transform. */
function migrateDeckFromV6toV7(doc: RawDoc): RawDoc {
  return doc;
}

/** v7 → v8: `Pane.remoteEndpoint` added — additive, nothing to transform. */
function migrateDeckFromV7toV8(doc: RawDoc): RawDoc {
  return doc;
}

/** v8 → v9: `Pane.idle` added — additive, nothing to transform. A v8 file's
 * panes simply carry no idle marker, which hydration reads as a plain wake:
 * exactly the wake-everything behaviour v8 had. */
function migrateDeckFromV8toV9(doc: RawDoc): RawDoc {
  return doc;
}

/** v9 → v10: `Pane.team` added — additive, nothing to transform. A v9 file's
 * panes belong to no team, which is what every pane is until somebody says
 * otherwise, so addressing falls back to pane titles exactly as before. */
function migrateDeckFromV9toV10(doc: RawDoc): RawDoc {
  return doc;
}

/**
 * v10 → v11: a team becomes an object the workspace holds.
 *
 * A v10 pane spells its membership as `{name, role}`; every pane holding the
 * same name (compared trimmed and lower-cased — the rule the dialog and the
 * plan already applied) was "the team". The hop mints one team per distinct
 * name in reading order, across the whole document, so a file always comes
 * back with the same ids, and rewrites each membership as `{teamId, role}`.
 * A half-written membership — no name, no role, only space — was read as no
 * membership before and becomes none here too. The rule is spelled out in
 * this file rather than borrowed from the model: a migration records what a
 * document went through, and must keep doing exactly that when the model's
 * rule moves on.
 */
function migrateDeckFromV10toV11(doc: RawDoc): RawDoc {
  const workspaces = doc.workspaces;
  if (!Array.isArray(workspaces)) return doc;
  const mint = { next: 1 };
  return {
    ...doc,
    workspaces: workspaces.map((ws) => migrateWorkspaceTeamsToV11(ws, mint)),
  };
}

function migrateWorkspaceTeamsToV11(value: unknown, mint: { next: number }): unknown {
  if (!isRecord(value) || !Array.isArray(value.panes)) return value;
  const teams: { id: string; name: string }[] = [];
  const panes = value.panes.map((pane) => {
    if (!isRecord(pane) || pane.team === undefined) return pane;
    const { team, ...rest } = pane;
    if (!isRecord(team) || typeof team.name !== "string" || typeof team.role !== "string") {
      return rest;
    }
    const name = team.name.trim();
    const role = team.role.trim();
    if (!name || !role) return rest;
    const key = name.toLowerCase();
    let held = teams.find((candidate) => candidate.name.toLowerCase() === key);
    if (!held) {
      held = { id: `team-${mint.next++}`, name };
      teams.push(held);
    }
    return { ...rest, team: { teamId: held.id, role } };
  });
  return { ...value, panes, ...(teams.length > 0 && { teams }) };
}

const DECK_MIGRATIONS: Record<number, Migration> = {
  1: migrateDeckFromV1toV2,
  2: migrateDeckFromV2toV3,
  3: migrateDeckFromV3toV4,
  4: migrateDeckFromV4toV5,
  5: migrateDeckFromV5toV6,
  6: migrateDeckFromV6toV7,
  7: migrateDeckFromV7toV8,
  8: migrateDeckFromV8toV9,
  9: migrateDeckFromV9toV10,
  10: migrateDeckFromV10toV11,
};

/**
 * settings.json — revision ledger:
 *   1 — defaultAgent, scrollback.
 *   2 — + experimentRunPresets.
 *   3 — + `minVersion` compatibility floor.
 *   4 — + plugins (per-plugin enabled flags & values).
 *   5 — experimentRunPresets retired: an explicit stored `false` maps to
 *       plugins.enabled["keepdeck.run"]=false at read (the Run panel is the
 *       run plugin now); the key itself is consumed, never re-written.
 *   6 — + plugins.consented (per-external-plugin capability fingerprints).
 *   7 — + deckLayout (grid|list) and minimizeStyle (tray|strip|none): the
 *       deck's display mode and how a minimized agent is shown in the grid.
 *   8 — + notifications (enabled, mode system-and-app|system|app,
 *       mutedPlugins): delivery channels for the notification system.
 *   9 — + defaultYolo: YOLO mode preselected wherever an agent is created.
 *  10 — + usageDisplay (used|left): which direction the usage chips'
 *       percentages run.
 *  11 — + remoteAgents: the Experimental toggle for the remote
 *       launch/connect surface (off by default).
 *  12 — + parkAgentsOnLaunch: restore agents stopped instead of waking them.
 *  13 — + dockMode (docked|floating): whether the right-hand dock takes a
 *       column beside the deck or floats over it.
 *  14 — + mcpServer: the Experimental toggle for the local MCP command
 *       socket (off by default). Also + suspendedAgentPlacement
 *       (pane|tray), which shipped without its own entry.
 *  15 — ABSENCE became authoritative. Up to v14 a save wrote a key only when
 *       its value differed from that build's default, so an absent key was
 *       ambiguous: nobody chose it, OR somebody chose exactly what happened
 *       to be the default and the writer dropped it. From v15 a save writes
 *       every key the user chose, so absence means "never chosen" and
 *       nothing else. No value changed shape or meaning — hence no ladder
 *       step and no raised floor — but the DOCUMENT now asserts something it
 *       could not assert before, and the next release that improves a default
 *       needs the two cases apart: it may adopt a better default for a v15
 *       file's absent key, while a v≤14 file's absent key may still be
 *       hiding a deliberate choice.
 * 16 — + agentTeams: the Experimental toggle for agent teams — roles,
 *       addressing by role, and messages between teammates (off by
 *       default).
 * 17 — + artifacts and artifactAutoOpen: the Experimental toggle for the
 *       fleet artifacts feature (agent-published presentation pages, the
 *       localhost display server, the artifact_* commands — off by
 *       default) and its auto-open companion (first publish of a NEW
 *       artifact opens the browser; true by default, inert while
 *       artifacts is off).
 * 18 — − mcpServer: the MCP transport lost its switch — the socket is up
 *       from the page's start to its end. A stored value is CONSUMED: read
 *       for nothing and never written back, so a file that carried it is
 *       not rewritten forever; nothing maps onto it, because there is no
 *       longer anything to choose.
 * 19 — − minimizeStyle: the tray became the only shape for a minimized
 *       agent (strip and none are gone). Consumed like mcpServer.
 * 20 — − deckLayout: the grid became the only deck layout (the list
 *       accordion is gone). Consumed like mcpServer.
 * 21 — − agentTeams: agent teams graduated from Experimental — roles,
 *       addressing by role and mail between teammates are simply on.
 *       Consumed like mcpServer.
 *
 * No ladder: the document is per-key tolerant (independent facts,
 * hand-editable), which IS its migration mechanism while changes stay
 * additive — a retired key is consumed, which is additive too. The first
 * step that changes a field's meaning gets a `migrateSettingsFromV*toV*`
 * here, a ladder like the deck's, and a raised floor.
 */
export const SETTINGS_VERSION = 21;
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
 * `null` = fine to read; a number = the floor that shuts this build out.
 *
 * Reads `minVersion` DIRECTLY, with no fall back to `version` (unlike the deck's
 * `floorOf`): settings hydration is per-key tolerant — unknown keys are
 * preserved and a bad value degrades to just its own default — so a file that
 * merely bumped its revision, including a hand-edited `version`, must read
 * tolerantly rather than quarantine every setting to defaults. Only an EXPLICIT
 * floor above our revision shuts us out; the deck, which can't read a newer
 * shape key-by-key, parks such a file instead. */
export function settingsFloorBreach(raw: RawDoc): number | null {
  const minVersion = raw.minVersion;
  if (typeof minVersion !== "number") return null; // no explicit floor: read tolerantly
  return minVersion > SETTINGS_VERSION ? minVersion : null;
}
