/**
 * What the Workspaces window shows — every workspace in one place, decided
 * apart from the markup: the list (the ones in the strip, then the archived
 * ones, newest first, narrowed by a search over name and folder) and the
 * page of the one picked.
 *
 * The page says what is true of an archive and nothing more: its agents are
 * suspended, everything else is kept, and Restore brings it back into the
 * strip with every agent as it is — nobody is woken.
 */
import {
  cwdLocked,
  teamsOf,
  type Workspace,
  type WorkspaceArchived,
  type WorkspaceUpdateRefusal,
} from "../domain/deck";
import { formatAge } from "../domain/usage";
import { counted } from "./countWords";
import { workspaceMarks } from "./workspaceMark";

export const WORKSPACES_WORDS = {
  title: "Workspaces",
  close: "Close workspaces",
  search: "Find a workspace",
  inStrip: "Active",
  archived: "Archived",
  noMatch: "No workspace matches.",
  restore: "Restore to the strip",
  archive: "Archive",
  closeWorkspace: "Close workspace",
  archivedBanner: (when: string) =>
    `Archived ${when}. Its agents are suspended; teams, worktrees, board and artifacts are kept.`,
  archivingBanner: "Being archived — its agents are stopping.",
  restoreNote: "Restore brings it back into the strip with every agent as it is — nobody is woken.",
  closeWhileArchiving: "It can be closed once the archive has stopped its agents.",
  identity: "Identity",
  name: "Name",
  mark: "Mark letters",
  markHint: "One or two characters for its mark in the strip. Leave it blank for letters from the name.",
  folders: "Folders",
  workingDirectory: "Working directory",
  worktreeFolder: "Worktree folder",
  choose: "Choose…",
  clear: "Clear",
  chooseWorkingDirectory: "Choose the workspace's working directory",
  chooseWorktreeFolder: "Choose where new teams' worktrees go",
  cwdLocked: "Can be changed only while the workspace has no teams and no agents.",
  noWorktreeFolder: "Next to the repo (suggested per team)",
  worktreeFolderHint: "Where new teams' worktrees go. Existing worktrees stay where they are.",
  readOnly: "An archived workspace is kept as it was — restore it to change it.",
} as const;

/** A refused edit, said on the page. The domain decided it; a picker never
 * hands a blank or relative folder, but the words stand for every kind. */
export function updateRefusalWords(refusal: WorkspaceUpdateRefusal): string {
  switch (refusal.kind) {
    case "unknown-workspace":
      return "This workspace is no longer open.";
    case "archived":
      return WORKSPACES_WORDS.readOnly;
    case "cwd-not-empty":
      return WORKSPACES_WORDS.cwdLocked;
    case "blank-cwd":
      return "A workspace needs a working directory.";
    case "relative-cwd":
      return "The working directory must be a full path.";
    case "mark-too-long":
      return "A mark holds one or two characters.";
  }
}

export interface WorkspaceListRow {
  id: string;
  name: string;
  initials: string;
  /** When it was archived — nothing for a workspace in use. */
  meta: string | null;
  selected: boolean;
}

export interface WorkspaceListGroup {
  label: string;
  /** How many rows it holds — drawn beside the label, apart from it. */
  count: number;
  rows: WorkspaceListRow[];
}

export interface WorkspacePageView {
  id: string;
  name: string;
  initials: string;
  cwd: string;
  /** "2 teams · 5 agents". */
  facts: string;
  /** In use, still being archived, or archived — with what it still owes. */
  state:
    | { kind: "in-use" }
    | { kind: "archiving"; banner: string }
    | { kind: "archived"; banner: string; owed: string | null };
  acts: {
    restore: boolean;
    archive: boolean;
    close: { disabled: boolean; refusal?: string };
  };
  /** Its own fields — editable while it is in use, shown as they are when
   * it is archived. */
  fields: {
    editable: boolean;
    name: string;
    /** The person's own letters, or "" — then `initials` are the name's. */
    mark: string;
    cwd: { path: string; locked: boolean };
    worktreeBaseDir: string | null;
  };
}

export interface WorkspacesWindowView {
  inStrip: WorkspaceListGroup;
  archived: WorkspaceListGroup;
  /** The search left no row in either group. */
  noMatch: boolean;
  page: WorkspacePageView | null;
}

export interface WorkspacesWindowInput {
  workspaces: readonly Workspace[];
  activeId: string;
  /** What the search field holds. */
  query: string;
  /** The workspace the person picked, or a door named. */
  focus: string | null;
  now: number;
}

/** Whether `ws` answers the search: its name or its folder holds the words,
 * case aside — what a person calls a workspace, and where it is. */
function matches(ws: Workspace, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || ws.name.toLowerCase().includes(q) || ws.cwd.toLowerCase().includes(q);
}

/** When it was put away, as a number to sort and age by. */
const archivedAt = (marker: WorkspaceArchived | undefined) => (marker ? Date.parse(marker.at) || 0 : 0);

/** What an archive could not finish, said once — or nothing when it owes
 * nothing. Its retry is the next launch's. */
function owedLine(marker: WorkspaceArchived): string | null {
  const owed = marker.warnings;
  if (!owed) return null;
  const parts: string[] = [];
  if (owed.reaps.length > 0) {
    parts.push(`${counted(owed.reaps.length, "agent")} did not stop cleanly`);
  }
  if (owed.disarm) parts.push("KeepDeck's files could not be taken out of its folders");
  return `${parts.join("; ")} — tried again on the next launch.`;
}

function pageOf(ws: Workspace, initials: string, now: number): WorkspacePageView {
  const marker = ws.archived;
  const teams = teamsOf(ws).length;
  const state: WorkspacePageView["state"] = !marker
    ? { kind: "in-use" }
    : marker.phase === "archiving"
      ? { kind: "archiving", banner: WORKSPACES_WORDS.archivingBanner }
      : {
          kind: "archived",
          banner: WORKSPACES_WORDS.archivedBanner(formatAge(archivedAt(marker), now)),
          owed: owedLine(marker),
        };
  return {
    id: ws.id,
    name: ws.name,
    initials,
    cwd: ws.cwd,
    facts: `${counted(teams, "team")} · ${counted(ws.panes.length, "agent")}`,
    state,
    fields: {
      editable: marker === undefined,
      name: ws.name,
      mark: ws.mark ?? "",
      cwd: { path: ws.cwd, locked: cwdLocked(ws) !== null },
      worktreeBaseDir: ws.worktreeBaseDir,
    },
    acts: {
      restore: marker !== undefined,
      archive: marker === undefined,
      close:
        marker?.phase === "archiving"
          ? { disabled: true, refusal: WORKSPACES_WORDS.closeWhileArchiving }
          : { disabled: false },
    },
  };
}

export function workspacesWindowView(input: WorkspacesWindowInput): WorkspacesWindowView {
  const { workspaces, activeId, query, focus, now } = input;
  // The page: what was picked, else the workspace on screen, else the first.
  const picked =
    workspaces.find((ws) => ws.id === focus) ??
    workspaces.find((ws) => ws.id === activeId) ??
    workspaces[0];
  // The letters the strip shows — one pass, so the window cannot disagree.
  const letters = workspaceMarks(workspaces);
  const initialsOf = (ws: Workspace) => letters.get(ws.id) ?? "?";
  const row = (ws: Workspace, meta: string | null): WorkspaceListRow => ({
    id: ws.id,
    name: ws.name,
    initials: initialsOf(ws),
    meta,
    selected: ws === picked,
  });
  const found = workspaces.filter((ws) => matches(ws, query));
  const inStrip = found.filter((ws) => ws.archived === undefined);
  const archived = found
    .filter((ws) => ws.archived !== undefined)
    .sort((a, b) => archivedAt(b.archived) - archivedAt(a.archived));
  return {
    inStrip: {
      label: WORKSPACES_WORDS.inStrip,
      count: inStrip.length,
      rows: inStrip.map((ws) => row(ws, null)),
    },
    archived: {
      label: WORKSPACES_WORDS.archived,
      count: archived.length,
      rows: archived.map((ws) =>
        row(ws, ws.archived?.phase === "archiving" ? "archiving" : formatAge(archivedAt(ws.archived), now)),
      ),
    },
    noMatch: found.length === 0 && workspaces.length > 0,
    page: picked ? pageOf(picked, initialsOf(picked), now) : null,
  };
}
