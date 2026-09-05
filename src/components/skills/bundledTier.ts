/**
 * What the bundled tier says about itself — the framing a read-only row
 * carries, and the unlock hint that framing sometimes needs.
 *
 * Pure text derived from one boolean: the controller reads the settings
 * port and threads the answer here, so the presentation layer holds no
 * store read and this module holds no dependency on the artifacts
 * feature. Doctrine travels with its subject rather than with whichever
 * component happened to render it.
 */

/** The panel's standing framing for a bundled row: what it is, and how
 * to make it yours. Selection IS the customization path — the design's
 * verdict was no fork machinery and no buttons, because "copy any part
 * into your own skill" is the affordance. */
export const BUNDLED_NOTICE =
  "Ships with KeepDeck and updates with it — read-only. To customize, create your own skill in Global: the text below is selectable, copy any part.";

/**
 * The unlock hint, shown only while the feature a bundled skill serves
 * is switched off.
 *
 * Editor visibility is UNGATED by design; only the STAGED views follow
 * the feature's backend claim. That divergence is deliberate — with the
 * setting on but the claim failed, no hint shows while the skill stays
 * un-armed, the same owned divergence as the tools.
 *
 * HONESTY NOTE: the wire carries no per-skill gate and every bundled
 * skill is gated today, so one sentence can speak for the tier. The day
 * an ungated one ships, the gate rides the wire and this narrows to the
 * gated rows only.
 *
 * `null` settings (the load is unsettled at boot) must reach here as
 * `true`: no hint on unknown, rather than a hint that blames a setting
 * nobody has read yet.
 */
export function bundledUnlockHint(artifactsOn: boolean): string | undefined {
  return artifactsOn
    ? undefined
    : "This skill arms agents only while Fleet artifacts are on (Settings → General).";
}
