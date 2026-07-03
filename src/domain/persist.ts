import type { DeckState } from "./deck";
import type { Pane, PaneSession } from "./panes";
import { resolveFocus } from "./panes";
import type { Workspace } from "./workspaces";
import { resolveActiveId } from "./workspaces";
import type { AgentType } from "./agents";
import { FALLBACK_AGENTS } from "./agents";
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
 * spawned) lazily per workspace by the app layer.
 */

export const DECK_STATE_VERSION = 1;

interface PersistedPane {
  id: string;
  agentType?: AgentType;
  cwd?: string;
  branch?: string;
  name?: string;
  autoTitle?: string;
  session?: PaneSession;
}

interface PersistedWorkspace {
  id: string;
  name: string;
  cwd: string;
  worktreeBaseDir: string | null;
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
}

/** Serialize the deck for storage. Runtime-only pane state (`dormant`) is
 * stripped; the session binding is kept — it's the resume key. */
export function serializeDeck(state: DeckState): string {
  const persisted: PersistedDeck = {
    version: DECK_STATE_VERSION,
    activeId: state.activeId,
    focusByWs: state.focusByWs,
    selectByWs: state.selectByWs,
    workspaces: state.workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      cwd: ws.cwd,
      worktreeBaseDir: ws.worktreeBaseDir,
      panes: ws.panes.map((p) => ({
        id: p.id,
        ...(p.agentType !== undefined && { agentType: p.agentType }),
        ...(p.cwd !== undefined && { cwd: p.cwd }),
        ...(p.branch !== undefined && { branch: p.branch }),
        ...(p.name !== undefined && { name: p.name }),
        ...(p.autoTitle !== undefined && { autoTitle: p.autoTitle }),
        ...(p.session !== undefined && { session: p.session }),
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
export function hydrateDeck(json: string): HydratedDeck | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== DECK_STATE_VERSION) return null;
  if (!Array.isArray(raw.workspaces)) return null;

  const workspaces: Workspace[] = [];
  for (const w of raw.workspaces) {
    const ws = readWorkspace(w);
    if (!ws) return null;
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
    state: {
      workspaces,
      activeId,
      focusByWs: readFocus(raw.focusByWs),
      selectByWs: readSelection(raw.selectByWs),
    },
    nextAgentSeq: maxSeq(workspaces.flatMap((w) => w.panes.map((p) => p.id)), "pane") + 1,
    nextWorkspaceSeq: maxSeq(workspaces.map((w) => w.id), "ws") + 1,
  };
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
  return { id, name, cwd, worktreeBaseDir, panes };
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
  return pane;
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
