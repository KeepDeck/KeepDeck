/**
 * What the deck bar's update control says and does, decided from the update
 * phase alone.
 *
 * It lived as five `&&` clauses and two ternaries inside the bar's markup — a
 * six-phase state machine spelled in JSX, where the only way to check a phase
 * was to read the rendered tree. Pure and alone it can be asserted directly,
 * and the markup goes back to drawing one button.
 *
 * The ACTION is described, not performed: a pure function that called
 * `restartToUpdate` would carry the updater singleton into every test that
 * wanted to know what the label says. The caller in the app layer owns the
 * wiring, which is also where the updater's own contract puts it — actions
 * are module functions, deliberately not React state (see `useUpdate`).
 *
 * Lives beside the update manager rather than under `domain/` because the
 * phase vocabulary is the manager's: a domain module may not depend on the
 * app layer, and copying the union down there to satisfy the rule would be
 * the same eight names maintained twice.
 */
import { isFoundUpdate, type UpdateState } from "./updateManager";

/** What pressing the control means. Named, not called — see the module note. */
export type UpdateAction =
  /** The bundle is downloaded and verified: swap it and relaunch. */
  | { kind: "restart" }
  /** Anything earlier: the settings section owns the rest of the flow. */
  | { kind: "openUpdatesSettings" };

/** Everything the bar needs to draw the control, once it is worth drawing. */
export interface UpdateActionView {
  label: string;
  /** Native tooltip. Names the version, which the label deliberately omits. */
  title: string;
  /** True while the updater is mid-step and a second press would do nothing. */
  disabled: boolean;
  action: UpdateAction;
}

/**
 * The control for `state`, or null when there is no update to speak of.
 *
 * Null rather than a disabled control: an idle updater has nothing to say,
 * and a permanently greyed button is a worse answer than an absent one. The
 * "is there anything" question stays [`isFoundUpdate`]'s — it is the same
 * question the settings section asks, and two spellings of it would drift.
 *
 * Pure.
 */
export function updateActionView(state: UpdateState): UpdateActionView | null {
  if (!isFoundUpdate(state)) return null;
  const version = state.version;
  switch (state.phase) {
    case "available":
      return {
        label: "Update available",
        title: `Version ${version ?? "?"} is available`,
        disabled: false,
        action: { kind: "openUpdatesSettings" },
      };
    case "ready":
      return {
        label: "Update ready · Restart",
        title: `Update to ${version ?? "new version"} and restart`,
        disabled: false,
        action: { kind: "restart" },
      };
    // The three in-flight phases: the user has already asked, and the only
    // honest thing left is to say which step is running. They keep the
    // `openUpdatesSettings` action because they are disabled — the field is
    // unreachable, and inventing a fourth kind for "nothing" would be a case
    // every caller has to handle to describe a press that cannot happen.
    case "downloading":
      return {
        label: "Downloading update…",
        title: `Version ${version ?? "?"} is available`,
        disabled: true,
        action: { kind: "openUpdatesSettings" },
      };
    case "discarding":
      return {
        label: "Discarding update…",
        title: `Version ${version ?? "?"} is available`,
        disabled: true,
        action: { kind: "openUpdatesSettings" },
      };
    case "installing":
      return {
        label: "Restarting…",
        title: `Version ${version ?? "?"} is available`,
        disabled: true,
        action: { kind: "openUpdatesSettings" },
      };
  }
}
