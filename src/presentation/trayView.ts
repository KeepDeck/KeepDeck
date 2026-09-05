/**
 * What the tray shows, decided apart from the markup that draws it: who is
 * on the shelf, in what order, for what reason — and what the grid says when
 * it is empty.
 *
 * These were an inline cluster in the stage's render: three sources of
 * restore callbacks, a priority between them, a four-step label ladder and a
 * five-branch title, all spelled in JSX and checkable only by rendering. Pure
 * and alone, each is a table. The ACTION is described, not performed — a
 * reason, which the stage turns into the callback it owns (the updateAction
 * precedent): a projection that called the deck would carry the store into
 * every test that wanted to know what the label says.
 *
 * Reasons come from the deck's one reading of the view's hidden lists,
 * `hiddenBy`, never from the lists themselves — so a reason the layout learns
 * to honour reaches the shelf through the same word, and an exhaustive switch
 * in the stage fails to compile until the shelf knows what to do with it.
 * `"maximized"` is added here and here only: the spotlight is not a reason a
 * pane is off the grid (it covers, it does not hide), but the shelf still
 * offers the covered panes back, and their restore is a spotlight switch.
 */
import {
  hiddenBy,
  paneIsSuspended,
  type HideReason,
  type Pane,
  type PaneVisibilityView,
} from "../domain/deck";

export type ShelfReason = HideReason | "maximized";

export interface ShelfEntry {
  paneId: string;
  reason: ShelfReason;
}

export type TrayStateLabel = "Hidden" | "Suspended" | "Minimized";

export interface TrayView {
  /** Pane order, one entry per shelved pane. */
  entries: readonly ShelfEntry[];
  stateLabel: TrayStateLabel;
}

/**
 * The shelf for one workspace.
 *
 * A pane carrying two reasons (minimized by hand, then suspended from the
 * grid) is shelved for the LAST one `hiddenBy` reports — the tray restore —
 * so the suspended pane comes back through the transition that knows how to
 * wake it, not through an unminimize that would leave it stopped.
 */
export function trayView(
  panes: readonly Pane[],
  view: PaneVisibilityView | undefined,
  focusedHere: string | null,
): TrayView {
  const entries: ShelfEntry[] = [];
  for (const pane of panes) {
    const reasons = hiddenBy(view, pane.id);
    if (reasons.length > 0) {
      entries.push({ paneId: pane.id, reason: reasons[reasons.length - 1] });
    } else if (focusedHere !== null && pane.id !== focusedHere) {
      entries.push({ paneId: pane.id, reason: "maximized" });
    }
  }
  return { entries, stateLabel: stateLabelOf(panes, entries) };
}

/** The shelf's one word for what it holds. Minimized and suspended agents
 * share one physical shelf, and a mixed shelf is named Hidden rather than
 * mislabeling stopped agents as merely minimized — as is a shelf holding a
 * tray pane that is not actually stopped. */
function stateLabelOf(panes: readonly Pane[], entries: readonly ShelfEntry[]): TrayStateLabel {
  const suspended = entries.filter((entry) => entry.reason === "suspendedTray");
  const others = entries.length - suspended.length;
  if (suspended.length > 0 && others > 0) return "Hidden";
  const byId = new Map(panes.map((pane) => [pane.id, pane]));
  if (suspended.some((entry) => !paneIsSuspended(byId.get(entry.paneId)!))) return "Hidden";
  return suspended.length > 0 ? "Suspended" : "Minimized";
}

/**
 * What the grid says when every pane is off it. Meaningful only then — the
 * stage gates the render on the grid being empty, and so should any other
 * caller. "They keep running" is only true while none of them is stopped: a
 * deck of suspended agents would otherwise be told the opposite of what it is.
 */
export function emptyGridMessage(
  panes: readonly Pane[],
  view: PaneVisibilityView | undefined,
): { title: string; sub: string } {
  // No spotlight on an empty grid: nothing is live to be covered.
  const { entries } = trayView(panes, view, null);
  const inTray = entries.filter((entry) => entry.reason === "suspendedTray");
  const minimized = entries.length - inTray.length;
  const byId = new Map(panes.map((pane) => [pane.id, pane]));
  const title =
    inTray.length === panes.length
      ? inTray.every((entry) => paneIsSuspended(byId.get(entry.paneId)!))
        ? "Every agent is suspended"
        : "Every agent is in the tray"
      : inTray.length > 0 && minimized > 0
        ? "Every agent is hidden"
        : inTray.length > 0
          ? "Every agent is in the tray"
          : "Every agent is minimized";
  const sub =
    inTray.length > 0
      ? "Restore one below to inspect it"
      : "They keep running — restore one below to bring it back";
  return { title, sub };
}
