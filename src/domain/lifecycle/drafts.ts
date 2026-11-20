/**
 * What the page drafts for the deck when it asks the lifecycle for a new
 * workspace, team or pane: everything the person chose, and nothing the
 * machine mints — the ids are the machine's. A draft travels through the
 * machine untouched (its journal keeps it opaque) and comes back in the
 * command that writes it, read here, field by field, the way every
 * persisted shape is read.
 */
import { isObjectLike, isOneOf } from "../json";
import type { PaneLocation } from "../deck";

export interface WorkspaceDraft {
  name: string;
  cwd: string;
  worktreeBaseDir: string | null;
}

export interface TeamDraft {
  name: string;
}

export interface PaneDraft {
  agentType: string;
  /** Its role on the team it lands on, as asked — the role rule admits it. */
  role: string;
  name?: string;
  yolo?: boolean;
  location?: PaneLocation;
  /** The recorded conversation it resumes, if any — one pane at a time may. */
  session?: { id: string };
}

const text = (value: unknown): value is string => typeof value === "string";

export function workspaceDraftOf(value: unknown): WorkspaceDraft | null {
  if (!isObjectLike(value) || !text(value.name) || !text(value.cwd)) return null;
  const base = value.worktreeBaseDir;
  if (base !== null && !text(base)) return null;
  return { name: value.name, cwd: value.cwd, worktreeBaseDir: base };
}

export function teamDraftOf(value: unknown): TeamDraft | null {
  return isObjectLike(value) && text(value.name) ? { name: value.name } : null;
}

function locationOf(value: unknown): PaneLocation | null {
  if (!isObjectLike(value) || !isOneOf(["remote"], value.kind) || !text(value.endpoint)) return null;
  return { kind: value.kind, endpoint: value.endpoint };
}

export function paneDraftOf(value: unknown): PaneDraft | null {
  if (!isObjectLike(value) || !text(value.agentType) || !text(value.role)) return null;
  const draft: PaneDraft = { agentType: value.agentType, role: value.role };
  if (value.name !== undefined) {
    if (!text(value.name)) return null;
    draft.name = value.name;
  }
  if (value.yolo !== undefined) {
    if (typeof value.yolo !== "boolean") return null;
    draft.yolo = value.yolo;
  }
  if (value.location !== undefined) {
    const location = locationOf(value.location);
    if (!location) return null;
    draft.location = location;
  }
  if (value.session !== undefined) {
    if (!isObjectLike(value.session) || !text(value.session.id)) return null;
    draft.session = { id: value.session.id };
  }
  return draft;
}
