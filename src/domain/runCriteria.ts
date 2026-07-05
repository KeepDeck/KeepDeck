import { all, criterion, type Criterion } from "./criteria";
import type { Settings } from "./settings";
import type { Workspace } from "./deck";

/**
 * The run feature's criteria — every surface of the experimental run presets
 * declares its availability HERE, as instances of the app's criterion
 * concept. Components evaluate a named rule instead of reading the flag, so
 * conditions change in one declaration (and graduating the experiment is
 * retiring one atom).
 *
 * Deliberately NOT part of any context: existing run sessions. Criteria gate
 * DISCOVERY — the surfaces that create things — never the life of what is
 * already running (a live dev server keeps its controls with the flag off).
 */

/** The experiment's master switch — the only place the flag is read outside
 * its editor (ExperimentsSection, which SETS it). */
const experimentOn: Criterion<{ settings: Settings | null }> = criterion(
  "run-experiment-on",
  ({ settings }) => settings?.experimentRunPresets ?? false,
);

/** The top bar's dock toggle. */
export const dockToggle = experimentOn;

/** The pane-header ▶ shortcut (select the pane, reveal the dock). */
export const paneRunShortcut = experimentOn;

/** The dock panel itself: feature on, toggled open, a workspace to serve. */
export const dockPanel = all<{
  settings: Settings | null;
  dockOpen: boolean;
  activeWorkspace: Workspace | null;
}>(
  "run-dock-panel",
  experimentOn,
  criterion("dock-toggled-open", ({ dockOpen }) => dockOpen),
  criterion(
    "has-active-workspace",
    ({ activeWorkspace }) => activeWorkspace !== null,
  ),
);

/** The workspace form's one-time setup-command field: worktrees must be in
 * play — setup runs at worktree creation and has nothing to prepare without
 * one. (A value typed while visible still submits if the flag flips
 * mid-form: criteria gate discovery, not input.) */
export const setupField = all<{
  settings: Settings | null;
  worktreeDir: string;
}>(
  "run-setup-field",
  experimentOn,
  criterion("worktrees-in-play", ({ worktreeDir }) => worktreeDir.trim() !== ""),
);
