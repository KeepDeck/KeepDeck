/**
 * Which of the tab's sections are open — UI state, kept per workspace.
 *
 * The tab is a stack of two sections under the root picker, Changes and
 * History, each with a header that is always visible. Any number may be
 * open; the open ones share the height and each scrolls its own list, the
 * closed ones sit pinned in their place. The default is Changes alone: the
 * log is read only while History is open, so a person who never opens it
 * never pays for it.
 */

export type SectionId = "changes" | "history";

export interface SectionsState {
  readonly changes: boolean;
  readonly history: boolean;
}

export const DEFAULT_SECTIONS: SectionsState = { changes: true, history: false };

export function toggleSection(state: SectionsState, id: SectionId): SectionsState {
  return { ...state, [id]: !state[id] };
}

/** The state as stored, or the default for anything that is not one — a
 * slot written by another revision, or never written. */
export function readSections(raw: unknown): SectionsState {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SECTIONS;
  const { changes, history } = raw as Record<string, unknown>;
  if (typeof changes !== "boolean" || typeof history !== "boolean") {
    return DEFAULT_SECTIONS;
  }
  return { changes, history };
}
