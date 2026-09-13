/**
 * Which root a dock tab shows — the rule the Files, Git and Run tabs share.
 *
 * The tab shows the highlighted pane's directory: "what I am looking at". A
 * pick by hand holds until the highlight CHANGES — clicking the pane that is
 * already highlighted changes nothing. And a root that is no longer offered
 * (its worktree was removed with its team) snaps back to the highlight's
 * directory, or the workspace folder, instead of staying on a path nobody
 * can read any more.
 *
 * Pure: the state is a value, the same object comes back when nothing
 * changed, so a render may reconcile it without a loop.
 */

export interface RootSelection {
  /** The root shown. */
  readonly target: string;
  /** The highlight this selection last followed — a change of it is what
   * moves the target off a hand pick. */
  readonly seenSelected: string | null;
}

export interface RootSelectionInput {
  selectedPaneId: string | null;
  panes: ReadonlyArray<{ id: string; cwd?: string }>;
  /** The workspace folder — where the tab lands with no highlight to follow. */
  fallback: string;
  /** Every root the tab offers right now. */
  roots: ReadonlyArray<string>;
}

/** Where the tab starts: the highlight's directory or the workspace folder. */
export function initialRootSelection(input: RootSelectionInput): RootSelection {
  return {
    target: highlighted(input) ?? input.fallback,
    seenSelected: input.selectedPaneId,
  };
}

/** The selection after this render's inputs: follow a changed highlight,
 * keep a hand pick otherwise, and leave a vanished root. */
export function followRootSelection(
  state: RootSelection,
  input: RootSelectionInput,
): RootSelection {
  let target = state.target;
  let seenSelected = state.seenSelected;
  if (input.selectedPaneId !== seenSelected) {
    seenSelected = input.selectedPaneId;
    target = highlighted(input) ?? target;
  }
  if (!input.roots.includes(target)) {
    target = highlighted(input) ?? input.fallback;
  }
  return target === state.target && seenSelected === state.seenSelected
    ? state
    : { target, seenSelected };
}

function highlighted(input: RootSelectionInput): string | undefined {
  return input.panes.find((pane) => pane.id === input.selectedPaneId)?.cwd;
}
