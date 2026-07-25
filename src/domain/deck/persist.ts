import { emptyJournal } from "../journal";
import type { DeckState, WorkspaceView } from "./reducer";
import type { Pane, PaneIdle, PaneProvisioning } from "./panes";
import { resolveFocus } from "./panes";
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
 * resume, everything else comes back `restored` for the revive sweep. The
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
      // Core field, sparse like plugins: an empty command never hits disk.
      ...(ws.setup !== undefined && ws.setup !== "" && { setup: ws.setup }),
      // Sparse: an empty bag (the last slot just got deleted) never hits disk.
      ...(ws.plugins !== undefined &&
        Object.keys(ws.plugins).length > 0 && { plugins: ws.plugins }),
      // A fork's provisioning card is dropped while still in flight: its store
      // surgery is an in-memory post-provision step that can't survive a
      // restart, so restoring the card would Retry into a non-fork pane (the
      // fork silently lost). The user re-forks from the journal; a RESOLVED
      // fork pane has no `provisioning` and persists normally.
      panes: ws.panes
        .filter((p) => !p.provisioning?.fork)
        .map((p) => ({
          ...p.extras,
          id: p.id,
          ...(p.agentType !== undefined && { agentType: p.agentType }),
          // Sparse like setup: only the armed mode hits disk.
          ...(p.yolo === true && { yolo: true }),
          ...(p.remoteEndpoint !== undefined && { remoteEndpoint: p.remoteEndpoint }),
          ...(p.cwd !== undefined && { cwd: p.cwd }),
          ...(p.branch !== undefined && { branch: p.branch }),
          ...(p.name !== undefined && { name: p.name }),
          ...(p.autoTitle !== undefined && { autoTitle: p.autoTitle }),
          ...(p.session !== undefined && { session: p.session }),
          // Sparse, and only the durable reason: `restored`/`parked` describe
          // a launch, so writing them would make every ordinary restart look
          // like a deliberate suspend on the NEXT one.
          ...(p.idle?.reason === "suspended" && { idle: p.idle }),
          // The intent only: error and phase are runtime state, and hydration
          // stamps its own error ("interrupted") on whatever comes back.
          ...(p.provisioning !== undefined && {
            provisioning: stripRuntime(p.provisioning),
          }),
        })),
    })),
  };
  return JSON.stringify(persisted);
}

/**
 * Restore a deck from stored JSON. Returns `null` for anything unusable —
 * unparsable JSON, an unknown version, a malformed shape — so the caller can
 * quarantine the file and start empty instead of crashing on state.
 *
 * Panes come back idle (`suspended` where that was stored, `restored`
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

/**
 * Apply the launch policy to a freshly hydrated deck: every pane the restore
 * left `restored` becomes `parked`, so the revive sweep leaves it alone and
 * each one starts from its own card instead of six CLIs launching at once.
 *
 * Kept out of [`hydrateDeck`] on purpose — hydration answers "what does this
 * document say", the setting answers "what should this launch do", and only
 * the second one changes when the user flips a checkbox. Panes the user
 * SUSPENDED are untouched: they are already stopped, and overwriting the
 * reason would lose the stamp their card is dated by.
 */
export function parkRestoredPanes(state: DeckState): DeckState {
  return {
    ...state,
    workspaces: state.workspaces.map((ws) => ({
      ...ws,
      panes: ws.panes.map((pane) =>
        pane.idle?.reason === "restored"
          ? { ...pane, idle: { reason: "parked" as const } }
          : pane,
      ),
    })),
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
  "setup",
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
  // Tolerant like `run`'s own setup: a non-string or blank value degrades to
  // absent rather than rejecting the workspace.
  if (typeof value.setup === "string" && value.setup.trim() !== "") {
    ws.setup = value.setup;
  }
  // Parsed unconditionally too, like `run` — a plugin's slot must survive a
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
  if (typeof value.remoteEndpoint === "string") pane.remoteEndpoint = value.remoteEndpoint;
  if (typeof value.cwd === "string") pane.cwd = value.cwd;
  if (typeof value.branch === "string") pane.branch = value.branch;
  if (typeof value.name === "string") pane.name = value.name;
  if (typeof value.autoTitle === "string") pane.autoTitle = value.autoTitle;
  const session = value.session;
  if (
    isRecord(session) &&
    typeof session.id === "string" &&
    typeof session.boundAt === "string"
  ) {
    pane.session = { id: session.id, boundAt: session.boundAt };
  }
  const provisioning = readProvisioning(value.provisioning);
  if (provisioning) {
    // The app quit mid-create: come back as the failed card — the intent
    // powers Retry, and the pane must NOT be idle or the revive flow would
    // spawn a terminal into a directory that may not exist.
    delete pane.idle;
    pane.provisioning = { ...provisioning, error: PROVISIONING_INTERRUPTED };
  }
  const extras = collectExtras(value, PANE_KNOWN_KEYS);
  // `idle` is a KNOWN key, so `collectExtras` would drop a marker written by a
  // NEWER revision (a reason this build has no name for) — and the sparse
  // write only re-emits our own `suspended`, so it would be gone for good.
  // Anything we didn't recognise rides along verbatim instead, like every
  // other unknown field. Our own suspend is excluded: it round-trips through
  // the typed field, and duplicating it would let a stale copy win later.
  if (value.idle !== undefined && pane.idle?.reason !== "suspended") {
    extras.idle = value.idle;
  }
  if (Object.keys(extras).length > 0) pane.extras = extras;
  return pane;
}

/** Why a restored pane has no PTY. A stored `suspended` marker is honoured —
 * that is the whole point of persisting it — and anything else (absent,
 * malformed, or a runtime reason a hand edit put there) degrades to
 * `restored`, so the pane simply wakes with the rest. Degrading toward "wake
 * it" is deliberate: the failure mode is an agent starting when it might not
 * have needed to, not one silently refusing to come back. */
function readIdle(value: unknown): PaneIdle {
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
  return { reason: "restored" };
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
 * a bad intent degrades the pane to a plain dormant one instead of rejecting
 * the deck (mirrors the agentType degradation above). */
function readProvisioning(
  value: unknown,
): Omit<PaneProvisioning, "error" | "phase"> | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.repo !== "string" ||
    typeof value.workspace !== "string" ||
    typeof value.index !== "number"
  )
    return null;
  const intent: Omit<PaneProvisioning, "error" | "phase" | "fork"> = {
    repo: value.repo,
    workspace: value.workspace,
    index: value.index,
  };
  if (typeof value.baseDir === "string") intent.baseDir = value.baseDir;
  if (value.runsSetup === true) intent.runsSetup = true;
  if (typeof value.path === "string") intent.path = value.path;
  if (typeof value.branch === "string") intent.branch = value.branch;
  if (typeof value.base === "string") intent.base = value.base;
  return intent;
}

/** The provisioning intent without its runtime `error`/`phase`/`fork` fields.
 * A fork card is dropped whole before this runs (see the serialize filter), so
 * excluding `fork` here is belt-and-suspenders: even if that filter were ever
 * weakened, the marker still never reaches disk — and the type stays honest
 * about the full runtime-only set. */
function stripRuntime(
  p: PaneProvisioning,
): Omit<PaneProvisioning, "error" | "phase" | "fork"> {
  const { error: _error, phase: _phase, fork: _fork, ...intent } = p;
  return intent;
}
