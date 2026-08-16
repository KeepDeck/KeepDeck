/**
 * The bundled skill's read-only viewer: name, description and body as
 * SELECTABLE TEXT — selection and copy work naturally, and that IS the
 * customization path (the design's verdict: no fork machinery, no
 * buttons; "copy any part into your own skill" is the affordance).
 * The panel carries the ships-with-KeepDeck framing and, while the
 * artifacts SETTING is off, the unlock hint — editor visibility is
 * UNGATED by design; only the STAGED views follow the feature's
 * backend claim (the setting-on-claim-failed divergence shows no hint
 * while the skill stays un-armed: the same owned divergence as the
 * tools). HONESTY NOTE: the wire carries no per-skill gate and every
 * bundled skill is gated today; the day an ungated one ships, the gate
 * rides the wire and this hint narrows to the gated rows only.
 */
import { useSettings } from "../../app/useSettings";
import type { SkillDraft } from "../../domain/skills";

export function SkillViewer({ draft }: { draft: SkillDraft }) {
  // null = the settings load is unsettled (boot): no hint on unknown.
  const settings = useSettings();
  const artifactsOff = settings !== null && settings.artifacts === false;
  return (
    <div className="skill-viewer kd-selectable">
      <p className="skill-viewer__note">
        Ships with KeepDeck and updates with it — read-only. To customize,
        create your own skill in Global: the text below is selectable,
        copy any part.
      </p>
      {artifactsOff && (
        <p className="skill-viewer__hint">
          This skill arms agents only while the artifacts experiment is on
          (Settings → Experimental).
        </p>
      )}
      <h3 className="skill-viewer__name">{draft.name}</h3>
      <p className="skill-viewer__description">{draft.description}</p>
      <pre className="skill-viewer__body">{draft.body}</pre>
    </div>
  );
}
