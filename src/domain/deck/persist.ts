import type { DeckState } from "./reducer";
import type { Pane, PaneProvisioning, PaneSession } from "./panes";
import { resolveFocus } from "./panes";
import type { WorkspaceRun } from "./workspaceRun";
import { readWorkspaceRun } from "./workspaceRun";
import type { Workspace } from "./workspaces";
import { resolveActiveId } from "./workspaces";
import type { AgentType } from "../agents";
import { FALLBACK_AGENTS } from "../agents";
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
 * Hydration marks every restored pane `dormant`: a PTY can't survive a restart,
 * so panes come back as quiet tiles and are revived (resumed or freshly
 * spawned) lazily per workspace by the app layer. The exception is a pane
 * whose worktree create was still in flight when the app quit — it comes back
 * NOT dormant but with its provisioning marked failed ("interrupted"), so the
 * card offers Retry instead of the revive flow spawning a terminal into a
 * directory that may not exist.
 */

import { DECK_MIN_READER, DECK_STATE_VERSION, migrateDeck } from "../migrations";

export { DECK_STATE_VERSION } from "../migrations";

/** What the app closed in the middle of creating: hydration stamps this onto
 * a restored in-flight provisioning so it surfaces as the failed card. */
export const PROVISIONING_INTERRUPTED = "Worktree creation was interrupted";

interface PersistedPane {
  id: string;
  agentType?: AgentType;
  cwd?: string;
  branch?: string;
  name?: string;
  autoTitle?: string;
  session?: PaneSession;
  /** The worktree-create intent, without the runtime `error`/`phase`. */
  provisioning?: Omit<PaneProvisioning, "error" | "phase">;
}

interface PersistedWorkspace {
  id: string;
  name: string;
  cwd: string;
  worktreeBaseDir: string | null;
  setup?: string;
  run?: WorkspaceRun;
  plugins?: Record<string, unknown>;
  panes: PersistedPane[];
}

export interface PersistedDeck {
  version: number;
  activeId: string;
  focusByWs: Record<string, string>;
  selectByWs: Record<string, string>;
  workspaces: PersistedWorkspace[];
}

/** What hydration yields: the restored state plus the id-mint floors derived
 * from the highest persisted `pane-N` / `ws-N` (never stored separately — one
 * source of truth). */
export interface HydratedDeck {
  state: DeckState;
  /** Seed for the agent-seq mint: one past the highest restored pane number. */
  nextAgentSeq: number;
  /** Seed for the workspace-seq mint: one past the highest restored ws number. */
  nextWorkspaceSeq: number;
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

/** Serialize the deck for storage. Runtime-only pane state (`dormant`) is
 * stripped; the session binding is kept — it's the resume key. */
export function serializeDeck(
  state: DeckState,
  docExtras: Record<string, unknown> = {},
): string {
  // Extras spread FIRST at every level, so the keys this build owns always
  // win — a newer revision's fields ride along, never override.
  const persisted: Record<string, unknown> = {
    version: DECK_STATE_VERSION,
    minVersion: DECK_MIN_READER,
    ...docExtras,
    activeId: state.activeId,
    focusByWs: state.focusByWs,
    selectByWs: state.selectByWs,
    workspaces: state.workspaces.map((ws) => ({
      ...ws.extras,
      id: ws.id,
      name: ws.name,
      cwd: ws.cwd,
      worktreeBaseDir: ws.worktreeBaseDir,
      // Core field, sparse like plugins: an empty command never hits disk.
      ...(ws.setup !== undefined && ws.setup !== "" && { setup: ws.setup }),
      ...(ws.run !== undefined && { run: ws.run }),
      // Sparse: an empty bag (the last slot just got deleted) never hits disk.
      ...(ws.plugins !== undefined &&
        Object.keys(ws.plugins).length > 0 && { plugins: ws.plugins }),
      panes: ws.panes.map((p) => ({
        ...p.extras,
        id: p.id,
        ...(p.agentType !== undefined && { agentType: p.agentType }),
        ...(p.cwd !== undefined && { cwd: p.cwd }),
        ...(p.branch !== undefined && { branch: p.branch }),
        ...(p.name !== undefined && { name: p.name }),
        ...(p.autoTitle !== undefined && { autoTitle: p.autoTitle }),
        ...(p.session !== undefined && { session: p.session }),
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
 * Panes come back `dormant`; `activeId` is re-resolved (the persisted one may
 * be stale); focus/selection entries pointing at unknown ids are dropped.
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

  return {
    kind: "ok",
    deck: {
      state: {
        workspaces,
        activeId,
        focusByWs: readFocus(raw.focusByWs),
        selectByWs: readSelection(raw.selectByWs),
        // Session-only by decision: never stored, every launch starts closed.
        dockByWs: {},
      },
      nextAgentSeq:
        maxSeq(workspaces.flatMap((w) => w.panes.map((p) => p.id)), "pane") + 1,
      nextWorkspaceSeq: maxSeq(workspaces.map((w) => w.id), "ws") + 1,
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
  "name",
  "cwd",
  "worktreeBaseDir",
  "setup",
  "run",
  "plugins",
  "panes",
]);

const PANE_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "id",
  "agentType",
  "cwd",
  "branch",
  "name",
  "autoTitle",
  "session",
  "provisioning",
]);

/** The object's keys outside `known` — a newer revision's fields, preserved
 * verbatim across our save round-trips. */
function collectExtras(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!known.has(key)) extras[key] = v;
  }
  return extras;
}

/** The restorable agent ids, derived from the one TS catalog — a hand-kept
 * copy here compiled clean while missing a newly added agent, silently
 * degrading its restored panes to the default. */
const AGENT_TYPES: readonly AgentType[] = FALLBACK_AGENTS.map((a) => a.id);

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
  const ws: Workspace = { id, name, cwd, worktreeBaseDir, panes };
  // Tolerant like `run`'s own setup: a non-string or blank value degrades to
  // absent rather than rejecting the workspace.
  if (typeof value.setup === "string" && value.setup.trim() !== "") {
    ws.setup = value.setup;
  }
  // Parsed unconditionally — the run-presets experiment flag gates UI entry
  // points, never stored data: a deck saved with the flag on must survive a
  // load-and-save with it off. Malformed → the workspace just has no config.
  const run = readWorkspaceRun(value.run);
  if (run) ws.run = run;
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
  const pane: Pane = { id: value.id, dormant: true };
  // An unknown agentType (a future agent, a hand-edited file) degrades to the
  // default rather than rejecting the whole deck.
  if (AGENT_TYPES.includes(value.agentType as AgentType)) {
    pane.agentType = value.agentType as AgentType;
  }
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
    // powers Retry, and the pane must NOT be dormant or the revive flow
    // would spawn a terminal into a directory that may not exist.
    delete pane.dormant;
    pane.provisioning = { ...provisioning, error: PROVISIONING_INTERRUPTED };
  }
  const extras = collectExtras(value, PANE_KNOWN_KEYS);
  if (Object.keys(extras).length > 0) pane.extras = extras;
  return pane;
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
  const intent: Omit<PaneProvisioning, "error" | "phase"> = {
    repo: value.repo,
    workspace: value.workspace,
    index: value.index,
  };
  if (typeof value.baseDir === "string") intent.baseDir = value.baseDir;
  if (typeof value.path === "string") intent.path = value.path;
  if (typeof value.branch === "string") intent.branch = value.branch;
  return intent;
}

/** The provisioning intent without its runtime `error`/`phase` fields. */
function stripRuntime(
  p: PaneProvisioning,
): Omit<PaneProvisioning, "error" | "phase"> {
  const { error: _error, phase: _phase, ...intent } = p;
  return intent;
}

/** Highest `<prefix>-N` among `ids` (0 when none match — seeds start at 1). */
function maxSeq(ids: string[], prefix: string): number {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
