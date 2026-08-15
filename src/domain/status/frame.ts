import type { PaneActivity } from "./activity";

/** The one frame a status surface wears — a closed set so the ladder is
 * exhaustive for every RANKER. The views are not exhaustive: they build
 * their class by interpolation (`pane--frame-${frame}` and kin), so a new
 * rung compiles and renders UNSTYLED until status.css paints it — the
 * type cannot enforce the paint, only this sentence can warn about it.
 * The `selected` rung means "the surface the user's cursor owns": the
 * selected pane's border on the deck, the active workspace's green on
 * the rail — one rung, because it is one fact (where the cursor is), and
 * one hex on purpose. */
export type StatusFrame =
  | "failed"
  | "waiting"
  | "selected"
  | "working"
  | "done"
  | "none";

/** How loudly one activity ranks — the ONE home of the ladder's order
 * (higher outranks lower): working outranks done (a live fact beats a
 * finished turn's tail) and stays below the attention pair. Exhaustive
 * on purpose: a new activity state fails to compile until it takes its
 * number here, and that one number decides the workspace fold, whether
 * the state outranks selection, and whether it may wear the full-bleed
 * rim — the three can never rank it differently. */
const SEVERITY: Record<PaneActivity["state"], number> = {
  failed: 4,
  waiting: 3,
  working: 2,
  done: 1,
};

/** States at or above this severity are ATTENTION — they take the frame
 * from selection, and they are the ONLY thing a full-bleed rim wears.
 * Selection's place in the ladder is this constant and nowhere else. */
const ATTENTION_FLOOR = 3;

/** Everything the ladder ranks about one pane — its live activity plus
 * its place on the deck, as FACTS. The view states what IS (the domain
 * defines the vocabulary, the deck answers it); every rule about what
 * those facts wear lives in [`paneFrame`]. The boundary the facts draw:
 * `fullBleed` names the stage-filling mode — maximized by hand, or the
 * only pane there is — which is a fact about layout, not a frame mode. */
export interface PaneFrameFacts {
  activity?: PaneActivity;
  /** Whether this surface wears the deck's selection border at all: a
   * gridded pane holding the cursor does; a list row never does (its
   * accordion expansion is its own selection mark — a green border would
   * double it), and neither does a hidden pane or a tray chip. Stating
   * that is a fact about the surface; WHAT the fact wears is the
   * ladder's, and the full-bleed gate below already yields selection to
   * the stage-filling mode. */
  selected: boolean;
  /** The pane fills the whole stage, so its border is the rim of
   * everything the user is already looking at. */
  fullBleed: boolean;
}

/** The place-half of [`PaneFrameFacts`] — everything but the live
 * activity, which the pane itself adds. Stated by the surface that owns
 * the layout semantics (the stage: a maximized or lone GRID pane fills
 * the stage; a list row never does, however its chrome flags read), so
 * the pane never has to guess its place from chrome props — `solo`
 * means "no maximize button" on a list row and "the whole stage" on a
 * grid pane, and only the stage knows which layout it is rendering. */
export type PaneFramePlace = Pick<PaneFrameFacts, "selected" | "fullBleed">;

/**
 * The single home of the frame priority ladder ([`paneBody`] precedent —
 * the domain decides, surfaces render). One frame, never a blend: mixing
 * two frames on one border was tried and rejected.
 *
 *   failed > waiting > (full-bleed gate) > selected > working > done > none
 *
 * The activity order lives in [`SEVERITY`] alone; this function adds the
 * two facts a bare number cannot hold:
 *
 * - WHERE selection sits: attention states outrank it because selection
 *   is where the cursor is, not where the eyes are — a selected pane's
 *   approval prompt is exactly as easy to miss as any other pane's.
 *   Working and done yield to it: the cursor's place outranks a live
 *   fact the selected pane's own header already spells out (working)
 *   and a courtesy tail of a finished turn (done).
 *
 * - WHAT a full-bleed rim says: attention only, and nothing else. There
 *   is nothing for selection to pick out — the pane IS the whole stage —
 *   and working/done are already read from the pane's own header in
 *   place; a rim repeating them at the screen's edge is noise. So a
 *   full-bleed pane with no attention wears no frame at all.
 *
 * Which surfaces state which facts is the surface's business (a list row
 * has no selection border to state — see [`PaneFrameFacts.selected`]);
 * what those facts wear is this ladder's. The MVP cut had spelled half
 * the grid's rule in the views as `selected && !focused && !solo` — the
 * full-bleed gate absorbed the `!focused && !solo` half of it.
 */
export function paneFrame(facts: PaneFrameFacts): StatusFrame {
  const { activity, selected, fullBleed } = facts;
  if (activity && SEVERITY[activity.state] >= ATTENTION_FLOOR) {
    return activity.state;
  }
  if (fullBleed) return "none";
  if (selected) return "selected";
  if (activity) return activity.state;
  return "none";
}

/**
 * The same ladder folded over a whole workspace — the rail dot's one
 * answer. Literally [`paneFrame`] of the workspace's LOUDEST pane under
 * the workspace's own facts (`selected: active` — the active dot's green
 * is the cursor rung; `fullBleed: false` — a rail dot is a small surface
 * that picks workspaces out, never the rim of what fills the stage), so
 * the two surfaces can never rank attention differently: any pane's
 * attention wins for the workspace (the ACTIVE workspace's dot goes
 * amber/red too — active is where the cursor is, not where the eyes
 * are), and working or done are worth a dot only on a background
 * workspace, exactly as they yield to selection on a pane.
 */
export function workspaceFrame(
  activities: Iterable<PaneActivity | undefined>,
  active: boolean,
): StatusFrame {
  let loudest: PaneActivity | undefined;
  for (const activity of activities) {
    if (!activity) continue;
    if (!loudest || SEVERITY[activity.state] > SEVERITY[loudest.state]) {
      loudest = activity;
    }
  }
  return paneFrame({
    activity: loudest,
    selected: active,
    fullBleed: false,
  });
}
