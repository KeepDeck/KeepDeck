import { emptyJournal } from "../journal";
import type { DeckState, WorkspaceView } from "./reducer";
import type { Pane, PaneIdle, PaneProvisioning, PlacementFields } from "./panes";
import {
  locationOf,
  paneIdleIsDurable,
  placementFromFields,
  placementToFields,
  provisioningCard,
  resolveFocus,
} from "./panes";
import type { Workspace } from "./workspaces";
import { resolveActiveId, workspaceIdsAreUnique } from "./workspaces";
import { nextIdSequence } from "../idSequence";
import { collectExtras, isRecord } from "../json";
import { createWorkspaceInstance } from "../workspaceInstance";
import { MAX_PANES } from "./layout";

/**
 * Deck persistence — schema, serialization and hydration ([F7]).
 *
 * The Rust side stores the JSON as an OPAQUE string (`deck_state_load`/
 * `deck_state_save` in src-tauri/src/state.rs): every bit of schema knowledge —
 * validation, versioning, future migrations — lives here, next to the model it
 * mirrors, where it's pure and unit-testable. There is deliberately no Rust DTO
 * to keep in sync.
 *
 * Hydration marks every restored pane idle: a PTY can't survive a restart, so
 * panes come back as quiet tiles and are revived (resumed or freshly spawned)
 * lazily per workspace by the app layer. The REASON survives the round trip: a
 * pane the user suspended comes back `suspended` and waits for an explicit
 * resume, everything else comes back waking for the revive sweep. The
 * exception is a pane whose worktree create was still in flight when the app
 * quit — it comes back NOT idle at all but with its provisioning marked failed
 * ("interrupted"), so the card offers Retry instead of the revive flow
 * spawning a terminal into a directory that may not exist.
 */

import { DECK_MIN_READER, DECK_STATE_VERSION, migrateDeck } from "../migrations";

export { DECK_STATE_VERSION } from "../migrations";

/** What the app closed in the middle of creating: hydration stamps this onto
 * a restored in-flight provisioning so it surfaces as the failed card. */
export const PROVISIONING_INTERRUPTED = "Worktree creation was interrupted";

/** What hydration yields: the restored state plus the pane-id mint floor
 * derived from the highest persisted `pane-N` (never stored separately — one
 * source of truth). Workspace ids are derived from the live deck at create
 * time, so they need no hydration seed. */
export interface HydratedDeck {
  state: DeckState;
  /** Seed for the agent-seq mint: one past the highest restored pane number. */
  nextAgentSeq: number;
  /** Unknown top-level keys of the stored document (a newer revision's
   * fields) — handed back to `serializeDeck` so saves never strip them. */
  docExtras: Record<string, unknown>;
}

/** How reading the stored deck ended. `corrupt` quarantines (evidence kept,
 * fresh start); `incompatible` PARKS the session — the file needs a newer
 * reader and must stay untouched, so saving is disabled entirely. */
export type HydrateDeckResult =
  | { kind: "ok"; deck: HydratedDeck }
  | { kind: "corrupt" }
  | { kind: "incompatible"; version: number; minVersion: number };

/** Serialize the deck for storage. Runtime-only pane state is stripped — of
 * the idle reasons only `suspended` is written, since it alone records a user
 * decision rather than this launch's circumstances; the session binding is
 * kept — it's the resume key. The unified
 * `viewByWs` persists only its durable half — the `focusByWs`/`selectByWs`
 * maps the on-disk schema has always had; `dock`/`dockTab` are session-only
 * and never written, so every launch starts with the dock closed. */
export function serializeDeck(
  state: DeckState,
  docExtras: Record<string, unknown> = {},
): string {
  const focusByWs: Record<string, string> = {};
  const selectByWs: Record<string, string> = {};
  for (const [wsId, view] of Object.entries(state.viewByWs)) {
    if (view.focus !== undefined) focusByWs[wsId] = view.focus;
    if (view.select !== undefined) selectByWs[wsId] = view.select;
  }
  // Extras spread FIRST at every level, so the keys this build owns always
  // win — a newer revision's fields ride along, never override.
  const persisted: Record<string, unknown> = {
    version: DECK_STATE_VERSION,
    minVersion: DECK_MIN_READER,
    ...docExtras,
    activeId: state.activeId,
    focusByWs,
    selectByWs,
    workspaces: state.workspaces.map((ws) => ({
      ...ws.extras,
      id: ws.id,
      name: ws.name,
      cwd: ws.cwd,
      worktreeBaseDir: ws.worktreeBaseDir,
      // Sparse: an empty bag (the last slot just got deleted) never hits disk.
      ...(ws.plugins !== undefined &&
        Object.keys(ws.plugins).length > 0 && { plugins: ws.plugins }),
      // A fork's provisioning card is dropped while still in flight: its store
      // surgery is an in-memory post-provision step that can't survive a
      // restart, so restoring the card would Retry into a non-fork pane (the
      // fork silently lost). The user re-forks from the journal; a RESOLVED
      // fork pane has no `provisioning` and persists normally.
      panes: ws.panes
        .filter((p) => !provisioningCard(p)?.fork)
        .map((p) => {
          // The location goes to disk as the four fields it replaced, in the
          // slots they always held — so a document a pane round-trips
          // through is the document it came from, byte for byte.
          const placement = placementToFields(locationOf(p));
          return {
          ...p.extras,
          id: p.id,
          ...(p.agentType !== undefined && { agentType: p.agentType }),
          // Sparse: only the armed mode hits disk.
          ...(p.yolo === true && { yolo: true }),
          ...(placement.remoteEndpoint !== undefined && {
            remoteEndpoint: placement.remoteEndpoint,
          }),
          ...(placement.cwd !== undefined && { cwd: placement.cwd }),
          ...(placement.branch !== undefined && { branch: placement.branch }),
          ...(p.name !== undefined && { name: p.name }),
          ...(p.autoTitle !== undefined && { autoTitle: p.autoTitle }),
          // A team describes a piece of work in progress, so it outlives a
          // restart: a deck that came back with everyone anonymous would
          // have silently disbanded a team nobody dismissed, and the roles
          // teammates address each other by would be gone with it.
          ...(p.team !== undefined && { team: p.team }),
          ...(p.session !== undefined && { session: p.session }),
          // Sparse, and only the durable reason: `waking`/`parked` describe
          // a launch, so writing them would make every ordinary restart look
          // like a deliberate suspend on the NEXT one.
          ...(paneIdleIsDurable(p.idle) && { idle: p.idle }),
          // The intent only: the error is runtime state, and hydration stamps
          // its own ("interrupted") on whatever comes back.
          ...(placement.provisioning !== undefined && {
            provisioning: stripRuntime(placement.provisioning),
          }),
          };
        }),
    })),
  };
  return JSON.stringify(persisted);
}

/**
 * Restore a deck from stored JSON. Returns `null` for anything unusable —
 * unparsable JSON, an unknown version, a malformed shape — so the caller can
 * quarantine the file and start empty instead of crashing on state.
 *
 * Panes come back idle (`suspended` where that was stored, waking
 * otherwise); `activeId` is re-resolved (the persisted one may be stale);
 * focus/selection entries pointing at unknown ids are dropped.
 */
export function hydrateDeck(json: string): HydrateDeckResult {
  const corrupt = { kind: "corrupt" } as const;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return corrupt;
  }
  if (!isRecord(parsed)) return corrupt;
  const outcome = migrateDeck(parsed);
  if (outcome.kind === "incompatible") return outcome;
  if (outcome.kind === "unusable") return corrupt;
  const raw = outcome.doc;
  if (!Array.isArray(raw.workspaces)) return corrupt;

  const workspaces: Workspace[] = [];
  for (const w of raw.workspaces) {
    const ws = readWorkspace(w);
    if (!ws) return corrupt;
    workspaces.push(ws);
  }
  // Duplicate ids make every by-id selector ambiguous and one close removes
  // several rows. Old buggy builds could persist them, so quarantine rather
  // than restoring a deck that violates the state owner's core invariant.
  if (!workspaceIdsAreUnique(workspaces)) return corrupt;

  const nextAgentSeq = nextIdSequence(
    workspaces.flatMap((w) => w.panes.map((p) => p.id)),
    "pane",
  );
  if (nextAgentSeq === null) return corrupt;

  const paneIdsByWs = new Map(
    workspaces.map((w) => [w.id, new Set(w.panes.map((p) => p.id))]),
  );
  const readSelection = (value: unknown): Record<string, string> => {
    if (!isRecord(value)) return {};
    const out: Record<string, string> = {};
    for (const [wsId, paneId] of Object.entries(value)) {
      if (typeof paneId === "string" && paneIdsByWs.get(wsId)?.has(paneId)) {
        out[wsId] = paneId;
      }
    }
    return out;
  };

  // A focus (maximize) entry must also still RESOLVE — a solo workspace is
  // never maximized, and a stale key persisted by an older version would
  // otherwise maximize the wrong pane as soon as a second pane is added.
  const readFocus = (value: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [wsId, paneId] of Object.entries(readSelection(value))) {
      const ws = workspaces.find((w) => w.id === wsId);
      if (ws && resolveFocus(ws.panes, paneId) === paneId) out[wsId] = paneId;
    }
    return out;
  };

  const activeId = resolveActiveId(
    workspaces,
    typeof raw.activeId === "string" ? raw.activeId : "",
  );

  // Reassemble the unified per-workspace view from the two flat on-disk maps.
  // `dock`/`dockTab` are session-only by decision — never stored, so every
  // launch starts with the dock closed on its default tab.
  const viewByWs: Record<string, WorkspaceView> = {};
  for (const [wsId, paneId] of Object.entries(readSelection(raw.selectByWs))) {
    viewByWs[wsId] = { ...viewByWs[wsId], select: paneId };
  }
  for (const [wsId, paneId] of Object.entries(readFocus(raw.focusByWs))) {
    viewByWs[wsId] = { ...viewByWs[wsId], focus: paneId };
  }

  return {
    kind: "ok",
    deck: {
      state: {
        workspaces,
        activeId,
        viewByWs,
        // deck.json carries no journal — the reducer's `hydrate` keeps the
        // live slice, and journal.jsonl hydrates separately after.
        journal: emptyJournal,
      },
      nextAgentSeq,
      docExtras: collectExtras(raw, DOC_KNOWN_KEYS),
    },
  };
}

/** The top-level keys this build owns; everything else is a doc extra. */
const DOC_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "version",
  "minVersion",
  "activeId",
  "focusByWs",
  "selectByWs",
  "workspaces",
]);

const WS_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "id",
  // Runtime-owned: ignore a hand-written/stale persisted value instead of
  // preserving it as a forward-compatible extra.
  "instance",
  "name",
  "cwd",
  "worktreeBaseDir",
  // NOT listed: "setup" — deck v5's one-time worktree command, retired with
  // the create-time agent batch that was its only runner. Leaving it unknown
  // routes an older document's value into `extras`, so it survives every save
  // round-trip verbatim instead of being dropped from the user's file.
  "plugins",
  "panes",
]);

const PANE_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "id",
  "agentType",
  "yolo",
  "remoteEndpoint",
  "cwd",
  "branch",
  "name",
  "autoTitle",
  "team",
  "session",
  "idle",
  "provisioning",
]);

/** The object's keys outside `known` — a newer revision's fields, preserved
 * verbatim across our save round-trips. */
function readWorkspace(value: unknown): Workspace | null {
  if (!isRecord(value)) return null;
  const { id, name, cwd, worktreeBaseDir } = value;
  if (typeof id !== "string" || typeof name !== "string" || typeof cwd !== "string")
    return null;
  if (worktreeBaseDir !== null && typeof worktreeBaseDir !== "string") return null;
  if (!Array.isArray(value.panes)) return null;
  // Every creation path clamps to MAX_PANES and the grid renderer throws past
  // it — an oversized (hand-edited) pane list is an unusable document, so it
  // quarantines like any other malformed shape instead of blanking the app on
  // every launch.
  if (value.panes.length > MAX_PANES) return null;

  const panes: Pane[] = [];
  for (const p of value.panes) {
    const pane = readPane(p);
    if (!pane) return null;
    panes.push(pane);
  }
  const ws: Workspace = {
    id,
    instance: createWorkspaceInstance(),
    name,
    cwd,
    worktreeBaseDir,
    panes,
  };
  // Parsed unconditionally, like `run` — a plugin's slot must survive a
  // load-and-save even while the plugin system experiment is off.
  const plugins = readWorkspacePlugins(value.plugins);
  if (plugins) ws.plugins = plugins;
  const extras = collectExtras(value, WS_KNOWN_KEYS);
  if (Object.keys(extras).length > 0) ws.extras = extras;
  return ws;
}

function readPane(value: unknown): Pane | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  const pane: Pane = { id: value.id, idle: readIdle(value.idle) };
  // Any non-empty string id is kept verbatim: the id set is OPEN (agents
  // come from plugins) and hydration runs BEFORE plugin bootstrap, so a
  // catalog check here would misfire on every boot. A pane whose plugin is
  // absent surfaces "agent unavailable" at render time — silently degrading
  // it to a default agent would resume the wrong CLI in its directory.
  if (typeof value.agentType === "string" && value.agentType) {
    pane.agentType = value.agentType;
  }
  // Strictly `true` — any other value degrades to the safe default (off),
  // matching the sparse write above.
  if (value.yolo === true) pane.yolo = true;
  // The four placement fields are read as written and folded into ONE
  // location below, once the card is known — the fold's own rule settles a
  // document that holds combinations the model cannot.
  const placement: PlacementFields = {};
  if (typeof value.remoteEndpoint === "string") placement.remoteEndpoint = value.remoteEndpoint;
  if (typeof value.cwd === "string") placement.cwd = value.cwd;
  if (typeof value.branch === "string") placement.branch = value.branch;
  if (typeof value.name === "string") pane.name = value.name;
  if (typeof value.autoTitle === "string") pane.autoTitle = value.autoTitle;
  // BOTH halves or neither: a role with no team cannot be addressed and a
  // team with no role gives its holder no name, so a half-written entry is
  // read as no membership rather than as a member nobody can reach.
  const team = value.team;
  if (
    isRecord(team) &&
    typeof team.name === "string" &&
    team.name &&
    typeof team.role === "string" &&
    team.role
  ) {
    pane.team = { name: team.name, role: team.role };
  }
  const session = value.session;
  if (
    isRecord(session) &&
    typeof session.id === "string" &&
    typeof session.boundAt === "string"
  ) {
    pane.session = { id: session.id, boundAt: session.boundAt };
  }
  const provisioning = readProvisioning(value.provisioning);
  if (provisioning) placement.provisioning = provisioning;
  const location = placementFromFields(placement);
  if (location.kind === "provisioning") {
    // The app quit mid-create: come back as the failed card — the intent
    // powers Retry, and the pane must NOT be idle or the revive flow would
    // spawn a terminal into a directory that may not exist.
    delete pane.idle;
    pane.location = {
      kind: "provisioning",
      card: { ...location.card, error: PROVISIONING_INTERRUPTED },
    };
  } else if (location.kind !== "main" || location.branch !== undefined) {
    // A plain main pane stays sparse: no key, like the fields it replaced.
    pane.location = location;
  }
  const extras = collectExtras(value, PANE_KNOWN_KEYS);
  if (Object.keys(extras).length > 0) pane.extras = extras;
  return pane;
}

/** Why a restored pane has no PTY. A stored `suspended` marker is honoured —
 * that is the whole point of persisting it — and anything else (absent,
 * malformed, or a reason from a NEWER revision this build has no name for)
 * degrades to a plain wake, so the pane simply comes up with the rest.
 *
 * The unknown marker is deliberately NOT carried through as a pane extra, the
 * way an unknown ordinary field is. Extras preserve facts this build does not
 * understand and does not touch; an idle marker is lifecycle state this build
 * rewrites within a second of opening the file — hydration marks every pane
 * idle and the sweep wakes it. Re-emitting the old marker afterwards would
 * tell the newer build that a pane it is watching run is still parked, which
 * is worse than the honest signal it gets from the marker's absence: an older
 * build took this pane somewhere else. */
function readIdle(value: unknown): PaneIdle {
  // The reason list here is the READ side of [`paneIdleIsDurable`], which
  // decides what the write side puts on disk. It cannot call it — a stored
  // marker is `unknown` until this function has validated its shape, and the
  // predicate takes a `PaneIdle` — but the two must name the same reasons: a
  // durable reason added to one and not the other is written on quit and
  // silently degraded to `parked` on the next launch.
  if (
    isRecord(value) &&
    value.reason === "suspended" &&
    typeof value.at === "string" &&
    // The stamp is rendered as an age ("2h ago"); an unparsable one would
    // print "NaNd ago". This file is hand-editable, so the shape check that
    // guards every other field guards this one too.
    Number.isFinite(Date.parse(value.at))
  ) {
    return { reason: "suspended", at: value.at };
  }
  // A marker we cannot make sense of: `parked`, not a wake. The pane stays
  // down with a card and a button rather than spawning a process — for a doc
  // that plainly meant "this pane was stopped", starting the agent anyway is
  // the destructive reading of corrupt data.
  //
  // The protection lasts exactly this launch, and deliberately so: `parked`
  // is runtime-only, so the first save drops the unreadable marker and the
  // NEXT launch wakes the pane normally. That is the intended trade — the
  // alternative, re-emitting a marker this build could not read, would carry
  // lifecycle state we don't understand into a document we do own, and
  // writing `suspended` instead would forge a decision the user never made.
  // One launch behind a card is enough for the user to decide.
  if (value !== undefined) return { reason: "parked" };
  return { reason: "waking", origin: "restore" };
}

/** Tolerant read of a persisted plugin-slot bag: `null` for anything that
 * isn't a plain object (the workspace simply has no plugin state, degrading
 * like a bad `run` config rather than rejecting the deck). A valid bag's
 * entries are kept VERBATIM — a slot's content is the owning plugin's
 * business, never validated below the persistence boundary (mirrors the
 * unknown-agentType degradation above, one level up: only the bag shape is
 * ours). */
function readWorkspacePlugins(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return { ...value };
}

/** The persisted worktree-create intent, or `null` when absent/malformed —
 * a bad intent degrades the pane to a plain idle one instead of rejecting
 * the deck (mirrors the agentType degradation above).
 *
 * A `workspace` key — the name an older build wrote into every intent — is
 * ignored: the branch name is built from the workspace's live name when the
 * create is issued, so nothing on disk is a source for it. The key leaves the
 * file on the next save; it is not kept as an extra, since extras are
 * collected at the pane's top level and never inside a slot. */
function readProvisioning(
  value: unknown,
): Omit<PaneProvisioning, "error"> | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.repo !== "string" ||
    typeof value.index !== "number" ||
    // A document written before agents arrived one at a time may hold a card
    // whose directory was the backend's to assign (`baseDir`, no `path`).
    // Nothing can place that any more, so it degrades like any other malformed
    // intent rather than restoring as a card whose Retry cannot work.
    typeof value.path !== "string"
  )
    return null;
  // Built in the order the factory writes the fields, so a card that
  // round-trips through a restart serializes byte for byte as it was saved.
  // Reading them in another order was harmless JSON and a different file.
  const intent: Omit<PaneProvisioning, "error" | "fork"> = {
    repo: value.repo,
    path: value.path,
    ...(typeof value.branch === "string" && { branch: value.branch }),
    ...(typeof value.base === "string" && { base: value.base }),
    index: value.index,
  };
  return intent;
}

/** The provisioning intent without its runtime `error`/`fork` fields. A fork
 * card is dropped whole before this runs (see the serialize filter), so
 * excluding `fork` here is belt-and-suspenders: even if that filter were ever
 * weakened, the marker still never reaches disk — and the type stays honest
 * about the full runtime-only set. */
function stripRuntime(
  p: PaneProvisioning,
): Omit<PaneProvisioning, "error" | "fork"> {
  const { error: _error, fork: _fork, ...intent } = p;
  return intent;
}
