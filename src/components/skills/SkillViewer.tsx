/**
 * The bundled skill's read-only viewer: name, description and body as
 * SELECTABLE TEXT — selection and copy work naturally, and that IS the
 * customization path (the design's verdict: no fork machinery, no
 * buttons; "copy any part into your own skill" is the affordance).
 * The panel carries the ships-with-KeepDeck framing and, for a gated
 * skill while its feature's toggle is off, the unlock hint — editor
 * visibility is UNGATED by design (the user sees what ships and how to
 * unlock it); only the STAGED views follow the feature's backend.
 */
import type { SkillDraft } from "../../domain/skills";

export function SkillViewer({ draft }: { draft: SkillDraft }) {
  return (
    <div className="skill-viewer kd-selectable">
      <p className="skill-viewer__note">
        Ships with KeepDeck and updates with it — read-only. To customize,
        create your own skill in Global: the text below is selectable,
        copy any part.
      </p>
      <h3 className="skill-viewer__name">{draft.name}</h3>
      <p className="skill-viewer__description">{draft.description}</p>
      <pre className="skill-viewer__body">{draft.body}</pre>
    </div>
  );
}
